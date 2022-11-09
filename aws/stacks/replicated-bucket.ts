import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import {IKey} from 'aws-cdk-lib/aws-kms';
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import {Construct} from 'constructs';

export interface ArchiveProps extends s3.BucketProps {
  bucketName: string;
  encryptionKey: IKey;
  replicateTo: string[];

}

const templateReplicationFile = path.resolve(__dirname, './replication.yml');
const templateReplicationData = fs.readFileSync(templateReplicationFile).toString();

export class ReplicatedBucket extends Construct {
  readonly account: string;
  readonly region: string;
  public sourceBucket: s3.Bucket;
  constructor(scope: Construct, id: string, props: ArchiveProps) {
    super(scope, id);

    const {replicateTo, ...cdkBucketProps} = props;
    this.account = cdk.Stack.of(this).account;
    this.region = cdk.Stack.of(this).region;

    this.sourceBucket = new s3.Bucket(this, 'Bucket', {
      ...cdkBucketProps,
      versioned: true,
    });
    //TODO: Remove for production
    props.encryptionKey.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    this.sourceBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    this.sourceBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        resources: [
          this.sourceBucket.bucketArn
        ],
        actions: [
          's3:DeleteBucket'
        ],
        principals: [
          new iam.AnyPrincipal()
        ]
      })
    )

    this.sourceBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        resources: [
          this.sourceBucket.arnForObjects('*')
        ],
        actions: [
          's3:DeleteObjectVersion'
        ],
        principals: [
          new iam.AnyPrincipal()
        ]
      })
    );


    const replicationRole = new iam.Role(this, 'ReplicationRole', {
      assumedBy: new iam.ServicePrincipal('s3.amazonaws.com'),
      path: '/service-role/'
    });

    const stackExecutionRole = new iam.Role(this, `StackSetExecutionRole-${props.bucketName}`, {
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'This role executes the stack set for this bucket',
    });

    const stackAdminRole = new iam.Role(this, `StackSetAdmin-${props.bucketName}`, {
        assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
        description: 'This role is Admin for the stackSet',
        inlinePolicies: {
          'assumeRole': new iam.PolicyDocument({
            assignSids: true,
            statements: [new iam.PolicyStatement({
              actions: ['sts:AssumeRole'],
              effect: iam.Effect.ALLOW,
              resources: [
                stackExecutionRole.roleArn,
              ]
            })
            ]
          })
        }
      }
    );

    stackExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowKMS',
        actions: ['kms:*'],
        resources: ['*']
      })
    );
    stackExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowS3',
        actions: ['s3:*'],
        resources: [`arn:aws:s3:::${props.bucketName}-replication-*`]
      })
    );

    stackExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CFPermissions',
        actions: [
          'cloudformation:*',
          'iam:PassRole',
          "iam:CreateServiceLinkedRole",

        ],
        resources: [
          `arn:aws:cloudformation:${this.region}:${this.account}:stackset/${props.bucketName}-replication:*`,
          `arn:aws:cloudformation:*:${this.account}:stack/StackSet-${props.bucketName}-replication*`,
          `arn:aws:cloudformation:${this.region}:${this.account}:stack/${props.bucketName}/*`,
        ]
      })
    );


    const stackSet = new cdk.CfnStackSet(this, 'StackSet', {
      stackSetName: `${props.bucketName}-replication`,
      permissionModel: 'SELF_MANAGED',
      administrationRoleArn: stackAdminRole.roleArn,
      executionRoleName: stackExecutionRole.roleName,
      operationPreferences: {
        regionConcurrencyType: 'PARALLEL'
      },
      parameters: [
        {
          parameterKey: 'SourceBucket',
          parameterValue: props.bucketName
        },
        {
          parameterKey: 'ReplicationRole',
          parameterValue: replicationRole.roleArn
        }
      ],
      stackInstancesGroup: [
        {
          regions: props.replicateTo,
          deploymentTargets: {
            accounts: [this.account],
          },
        },
      ],
      templateBody: templateReplicationData,
    });

    stackSet.addDependsOn(stackExecutionRole.node.defaultChild as iam.CfnRole);

    props.encryptionKey.grantDecrypt(replicationRole);
    replicationRole.addToPolicy(
      new iam.PolicyStatement({
        resources: [
          this.sourceBucket.bucketArn
        ],
        actions: [
          's3:GetReplicationConfiguration',
          's3:ListBucket'
        ]
      })
    );
    replicationRole.addToPolicy(
      new iam.PolicyStatement({
        resources: [
          this.sourceBucket.arnForObjects('*')
        ],
        actions: [
          's3:GetObjectVersion',
          's3:GetObjectVersionAcl',
          's3:GetObjectVersionForReplication',
          's3:GetObjectVersionTagging'
        ]
      })
    );

    replicationRole.addToPolicy(
      new iam.PolicyStatement({
        resources: props.replicateTo.map(
          region => `arn:aws:kms:${region}:${this.account}:alias/${props.bucketName}/replication`
        ),
        actions: [
          'kms:Encrypt'
        ]
      })
    );

    replicationRole.addToPolicy(
      new iam.PolicyStatement({
        resources: props.replicateTo.map(
          region => `arn:aws:s3:::${props.bucketName}-replication-${region}/*`
        ),
        actions: [
          's3:ReplicateDelete',
          's3:ReplicateObject',
          's3:ReplicateTags'
        ]
      })
    );

    replicationRole.addToPolicy(
      new iam.PolicyStatement({
        resources: props.replicateTo.map(
          region => `arn:aws:s3:::${props.bucketName}-replication-${region}`
        ),
        actions: [
          's3:List*',
          's3:GetBucketVersioning',
          's3:PutBucketVersioning'
        ]
      })
    );

    const cfnBucket = this.sourceBucket.node.defaultChild as s3.CfnBucket;

    // Change its properties
    cfnBucket.replicationConfiguration = {
      role: replicationRole.roleArn,
      rules: props.replicateTo.map(
        (region, index) => (
          {
            id: region,
            destination: {
              bucket: `arn:aws:s3:::${props.bucketName}-replication-${region}`,
              encryptionConfiguration: {
                replicaKmsKeyId: `arn:aws:kms:${region}:${this.account}:alias/${props.bucketName}/replication`
              }
            },
            priority: index,
            deleteMarkerReplication: {
              status: 'Enabled'
            },
            filter: {
              prefix: ''
            },
            sourceSelectionCriteria: {
              sseKmsEncryptedObjects: {
                status: 'Enabled'
              }
            },
            status: 'Enabled'
          }
        )
      )
    };

    cfnBucket.addDependsOn(stackSet);

  }
}
