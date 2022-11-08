#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';

import { ArchiveStack } from './stacks/archive'

const bucketName = 'wese'
const option = {
  bucketName,
  env: {
    region: 'eu-central-1'
  },
  replications: [
    'eu-west-1',
    'eu-north-1'
  ]
}

const app = new cdk.App()

new ArchiveStack(app, 'Archive', {
  bucketProps: {},
  stackName: `${bucketName}-archive`,
  terminationProtection: false,
  tags: {
    stack: 'replication',
    delete: 'me',
  },
  ...option
})
