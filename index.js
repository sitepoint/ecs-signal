'use strict';

const response   = require('./lib/cfn-response');
const async      = require('async');
const aws        = require('aws-sdk');
const parseEvent = require('./lib/parseEvent');
const selectn    = require('selectn');

const asg = new aws.AutoScaling();
const ecs = new aws.ECS();
const elb = new aws.ELB();

// instances
let instancesOld = [];
let instancesNew = [];
let instancesECS = [];
let instanceMap  = [];

let ecsServiceArns = [];
let ecsServiceDefinitions = [];

exports.handler = ( event, context, callback ) => {
  console.log('REQUEST RECEIVED:', JSON.stringify(event));

  const cfnEvent = parseEvent(event);

  async.waterfall([
    (cb) => cb(null, event, cfnEvent),
    testForEvent,
    testForOldASG,
    getServiceArns,
    testForServiceArns,
    getASGInstances,
    getContainerInstances,
    getContainerInstanceDetails,
    getServiceDetails,
    deregisterInstances,
    waitForServices,
    waitForELBs
  ], function(err, result) {
    if (err) {
      console.log(err);
      if (err == 'ok') {
        response.send(event, context, response.SUCCESS);
        return callback();
      } else {
        response.send(event, context, response.FAILURE);
        return callback(err);
      }
    }
    response.send(event, context, response.SUCCESS);
    return callback();
  });

}

const testForEvent = (event, cfnEvent, cb) => {
  // resource creation or deletion is totally fine and doesn't need to be
  // dealt with
  if (event.RequestType == 'Delete' || event.RequestType == 'Create') {
    console.log(`Don't care about ${event.RequestType} events`);
    return cb('ok');
  }
  cb(null, cfnEvent);
}

const testForOldASG = (cfnEvent, cb) => {
  console.log('CALLING testForOldASG');
  if (cfnEvent.asgOld === undefined) {
    return cb('ok');
  }
  cb(null, cfnEvent);
}

const testForServiceArns = (cfnEvent, cb) => {
  console.log('CALLING testForServiceArns');
  if (ecsServiceArns.length == 0) {
    return cb('ok');
  }
  cb(null, cfnEvent);
};

const getServiceArns = (cfnEvent, cb) => {
  console.log('CALLING getServiceArns');
  ecs.listServices({ cluster: cfnEvent.cluster }, function(err, data) {
    if (err) return cb(err);

    ecsServiceArns = data.serviceArns;

    console.log(ecsServiceArns);
    cb(null, cfnEvent);
  });
}

const getASGInstances = (cfnEvent, cb) => {
  console.log('CALLING getASGInstances');
  asg.describeAutoScalingGroups({ AutoScalingGroupNames: [ cfnEvent.asgNew, cfnEvent.asgOld ]}, function(err, data) {
    if (err) return cb(err);

    data.AutoScalingGroups.map(function(ASGInfo){
      if (ASGInfo.AutoScalingGroupName == cfnEvent.asgOld) {
        instancesOld = ASGInfo.Instances.map(selectn('InstanceId'));
      } else {
        instancesNew = ASGInfo.Instances.map(selectn('InstanceId'));
      }
    });

    console.log(instancesOld);
    console.log(instancesNew);
    cb(null, cfnEvent);
  });
}

const getContainerInstances = (cfnEvent, cb) => {
  console.log('CALLING getContainerInstances');
  ecs.listContainerInstances({ cluster: cfnEvent.cluster}, function(err, data) {
    if (err) return cb(err);

    instancesECS = data.containerInstanceArns;

    console.log(instancesECS);
    cb(null, cfnEvent);
  });
}

const getContainerInstanceDetails = (cfnEvent, cb) => {
  console.log('CALLING getContainerInstanceDetails');
  ecs.describeContainerInstances({containerInstances: instancesECS, cluster: cfnEvent.cluster}, function(err, data){
    if (err) return cb(err);

    data.containerInstances.map(function(instance) {
      instanceMap[instance.ec2InstanceId] = instance.containerInstanceArn;
    });

    console.log(instanceMap);
    cb(null, cfnEvent);
  });
}

const getServiceDetails = (cfnEvent, cb) => {
  console.log('CALLING getServiceDetails');
  ecs.describeServices({ services: ecsServiceArns, cluster: cfnEvent.cluster }, function(err, data) {
    if (err) return cb(err);

    data.services.map(function(service) {
      ecsServiceDefinitions.push({
        loadBalancers: service.loadBalancers.map(lb => lb.loadBalancerName),
        desiredCount: service.desiredCount,
        serviceArn: service.serviceArn,
        serviceStatus: service.status
      });
    });

    console.log(ecsServiceDefinitions);
    cb(null, cfnEvent);
  });
}

const deregisterInstances = (cfnEvent, cb) => {
  console.log('CALLING deregisterInstances');
  mapInstanceNames(instancesOld).map(function(instanceId){
    forceDeregisterInstance(instanceId, cfnEvent, cb);
  });
  cb(null, cfnEvent);
}

const forceDeregisterInstance = (instanceId, cfnEvent, cb) => {
  console.log(`CALLING forceDeregisterInstance with ${instanceId}`);
  ecs.deregisterContainerInstance({containerInstance: instanceId, cluster: cfnEvent.cluster, force: true }, function(err, data) {
    if (err) return cb(err);
  });
}

const waitForServices = (cfnEvent, cb) => {
  console.log('CALLING waitForServices');
  ecs.waitFor('servicesStable', {services: ecsServiceArns, cluster: cfnEvent.cluster}, function(err, data){
    if (err) return cb(err);

    cb(null, cfnEvent);
  });
}

const waitForELBs = (cfnEvent, cb) => {
  console.log('CALLING waitForELBs');
  let elbNames = ecsServiceDefinitions.map(service => service.loadBalancers).reduce((a,b) => a.concat(b));

  async.map(elbNames,
    (elb, callback) => {
      async.retry(
        { times: 25, interval: 10000 },
        (done, results) => {
          checkLoadBalancer(done, elb);
        },
        (err, result) => {
          if (err) return callback(err);
          console.log(elbNames);
          callback(null);
        }
      )
    },
    (err, results) => {
      if (err) return cb(err);
      cb(null, cfnEvent);
    }
  );
}

const checkLoadBalancer = (cb, loadBalancer) => {
  console.log(`CALLING checkLoadBalancer with ${loadBalancer}`);
  elb.describeInstanceHealth({ LoadBalancerName: loadBalancer }, function(err, data){
    if (err) return cb('not yet');

    if (data.InstanceStates.map(instance => instance.State == 'InService').every(elem => elem)) {
      return cb(null);
    } else {
      return cb('not yet');
    }
  });
}

const mapInstanceNames = (arr) => arr.map(id => instanceMap[id]);
