#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import {Duration} from 'aws-cdk-lib';

import {ReplicatedBucket} from './stacks/replicated-bucket';
import {Key} from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import {BucketAccessControl, BucketEncryption} from 'aws-cdk-lib/aws-s3';
import {Effect, PolicyStatement, ServicePrincipal} from 'aws-cdk-lib/aws-iam';

class ReplicateTestStack extends cdk.Stack {

  constructor(scope: cdk.App, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    const key = new Key(this, 'ServiceKey', {
      pendingWindow: Duration.days(7)

    });
    const logBucket = new s3.Bucket(this, 'LogBucket', {
      accessControl: BucketAccessControl.LOG_DELIVERY_WRITE,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
    });
    logBucket.addToResourcePolicy(new PolicyStatement({
      sid: 'AllowLogDelivery',
      effect: Effect.ALLOW,
      principals: [ new ServicePrincipal('logging.s3.amazonaws.com') ],
      actions: ['s3:PutObject'],
      resources: [ logBucket.arnForObjects('*') ]
    }));

    const replicatedBucket = new ReplicatedBucket(this, 'SourceBucket', {
      bucketName: `locked-testbucket-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      bucketKeyEnabled: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      replicateTo: ['eu-north-1', 'eu-west-1'],
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: `S3AccessLogs/testbucket-${this.account}/`
    });
  }
}


const app = new cdk.App()

new ReplicateTestStack(app, 'Stack', {
  terminationProtection: false,
  env: {
    region: 'eu-central-1',
    account: '974281796532'
  },
  tags: {
    stack: 'replication',
    delete: 'me',
  },
})
