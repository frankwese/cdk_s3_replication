import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import {IKey} from 'aws-cdk-lib/aws-kms';
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import {Construct} from 'constructs';
import {NagSuppressions} from 'cdk-nag';
import {StorageClass} from 'aws-cdk-lib/aws-s3';

export interface ArchiveProps extends s3.BucketProps {
  bucketName: string;
  encryptionKey: IKey;
  /**
   * an array of regions to replicate to
   */
  replicateTo: string[];
  /**
   * storageClass to use in the replicated buckets
   */
  destinationStorageClass?: StorageClass;

}

const templateReplicationFile = path.resolve(__dirname, './replication.yml');
const templateReplicationData = fs.readFileSync(templateReplicationFile).toString();

/**
 * creates a Bucket that is replicated to the specified regions.
 * The source Bucket is created with the properties you supply in the constructor.
 * To make replication possible
 * <ul>
 * <li> the <code>versioned</code> property is always set to true
 * <li> <code>encryptionKey</code> is required
 * </ul>
 * <b>
 * You cannot use this Construct in env agnostic Stack, because it needs to know the account and region.
 * </b>
 * This Construct is heavily inspired from https://github.com/sbstjn/archive
 */
export class ReplicatedBucket extends Construct {
  readonly account: string;
  readonly region: string;
  /**
   * The Bucket that is the origin.
   */
  public readonly sourceBucket: s3.Bucket;
  constructor(scope: Construct, id: string, props: ArchiveProps) {
    super(scope, id);

    const {replicateTo, destinationStorageClass, ...cdkBucketProps} = props;
    this.account = cdk.Stack.of(this).account;
    this.region = cdk.Stack.of(this).region;

    this.sourceBucket = new s3.Bucket(this, 'Bucket', {
      ...cdkBucketProps,
      versioned: true,
    });

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
    );

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
              },
              storageClass: destinationStorageClass ? destinationStorageClass.toString() : undefined
            },
            priority: index,
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

    NagSuppressions.addResourceSuppressions(replicationRole, [
      {id: 'AwsSolutions-IAM5', reason:'This role needs to perform replication on all objects in the specified buckets'}
    ], true);
    NagSuppressions.addResourceSuppressions(stackExecutionRole, [
      {id: 'PCI.DSS.321-IAMPolicyNoStatementsWithFullAccess', reason: 'This role needs to create KMS keys, CF Stacks and other resources. The permission set has wildcards to not exceed the size limit'},
      {id: 'AwsSolutions-IAM5', reason: 'This role needs to create KMS keys, CF Stacks and other resources. The permission set has wildcards to not exceed the size limit'}
    ], true);
  }
}
