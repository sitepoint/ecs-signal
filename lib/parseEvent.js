'use strict';

const selectn = require('selectn');

module.exports = (event) => {
  return {
    asgOld: selectn('OldResourceProperties.AutoScalingGroup', event),
    asgNew: selectn('ResourceProperties.AutoScalingGroup', event),
    cluster: selectn('ResourceProperties.ECSCluster', event),
    stackName: selectn('ResourceProperties.StackName', event)
  }
}