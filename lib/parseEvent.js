'use strict';

const selectn = require('selectn');

module.exports = (event) => {
  return {
    asgOld: selectn('OldResourceProperties.AutoScalingGroup', event),
    asgNew: selectn('ResourceProperties.AutoScalingGroup', event),
    clusterNew: selectn('ResourceProperties.ECSCluster', event),
    clusterOld: selectn('OldResourceProperties.ECSCluster', event),
    stackName: selectn('ResourceProperties.StackName', event)
  }
}