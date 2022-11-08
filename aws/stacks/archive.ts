import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cdk from 'aws-cdk-lib';

import * as fs from 'fs';
import * as path from 'path';
//TODO: extends s3.BucketProps only have additional replicateTo
export interface ArchiveProps extends cdk.StackProps {
  bucketName: string;
  replications: string[];
  bucketProps: s3.BucketProps;
}

const templateReplicationFile = path.resolve(__dirname, '../templates/replication.yml');
const templateReplicationData = fs.readFileSync(templateReplicationFile).toString();

//TODO: extend Construct
export class ArchiveStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: ArchiveProps) {
    super(scope, id, props);

    const {replications, ...cdkBucketProps} = props;

//TODO: use the provided key from cdkBucketProps
    const key = new kms.Key(this, 'Key');
    const alias = key.addAlias(`${props.bucketName}`);

    const bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: props.bucketName,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: alias,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      bucketKeyEnabled: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    });

    //TODO: Remove for production
    key.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    bucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        resources: [
          bucket.bucketArn
        ],
        actions: [
          's3:DeleteBucket'
        ],
        principals: [
          new iam.AnyPrincipal()
        ]
      })
    )

    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        resources: [
          bucket.arnForObjects('*')
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
          regions: props.replications,
          deploymentTargets: {
            accounts: [this.account],
          },
        },
      ],
      templateBody: templateReplicationData,
    });

    stackSet.addDependsOn(stackExecutionRole.node.defaultChild as iam.CfnRole);
    replicationRole.addToPolicy(
      new iam.PolicyStatement({
        resources: [
          bucket.bucketArn
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
          bucket.arnForObjects('*')
        ],
        actions: [
          's3:GetObjectVersion',
          's3:GetObjectVersionAcl',
          's3:GetObjectVersionForReplication',
          's3:GetObjectVersionTagging'
        ]
      })
    );

    //TODO: check if this works (it is shorter)
    key.grantDecrypt(replicationRole);
    replicationRole.addToPolicy(
      new iam.PolicyStatement({
        resources: [
          key.keyArn
        ],
        actions: [
          'kms:Decrypt'
        ]
      })
    );

    replicationRole.addToPolicy(
      new iam.PolicyStatement({
        resources: props.replications.map(
          region => `arn:aws:kms:${region}:${this.account}:alias/${props.bucketName}/replication`
        ),
        actions: [
          'kms:Encrypt'
        ]
      })
    );

    replicationRole.addToPolicy(
      new iam.PolicyStatement({
        resources: props.replications.map(
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
        resources: props.replications.map(
          region => `arn:aws:s3:::${props.bucketName}-replication-${region}`
        ),
        actions: [
          's3:List*',
          's3:GetBucketVersioning',
          's3:PutBucketVersioning'
        ]
      })
    );

    const cfnBucket = bucket.node.defaultChild as s3.CfnBucket;

    // Change its properties
    cfnBucket.replicationConfiguration = {
      role: replicationRole.roleArn,
      rules: props.replications.map(
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
