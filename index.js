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
  console.log('REQUEST RECEIVED:\\n', JSON.stringify(event));

  // resource creation or deletion is totally fine and doesn't need to be
  // dealt with
  if (event.RequestType == 'Delete' || event.RequestType == 'Create') {
    response.send(event, context, response.SUCCESS);
    return;
  }

  const s3Event = parseEvent(event);

  async.waterfall([
    function(callback) { callback(null, s3Event) },
    getASGInstances,
    getContainerInstances,
    getContainerInstanceDetails,
    getServiceArns,
    getServiceDetails,
    deregisterInstances,
    waitForServices,
    waitForELBs
  ], function(err, result) {
    if (err) {
      console.log(err);
      response.send(event, context, response.FAILURE);
    }
    response.send(event, context, response.SUCCESS);
  });
};

const getASGInstances = (s3Event, callback) => {
  asg.describeAutoScalingGroups({ AutoScalingGroupNames: [ s3Event.asgNew, s3Event.asgOld ]}, function(err, data) {
    if (err) callback(err);

    data.AutoScalingGroups.map(function(ASGInfo){
      if (ASGInfo.AutoScalingGroupName == s3Event.asgOld) {
        instancesOld = ASGInfo.Instances.map(selectn('InstanceId'));
      } else {
        instancesNew = ASGInfo.Instances.map(selectn('InstanceId'));
      }
    });

    callback(null, s3Event);
  });
}

const getContainerInstances = (s3Event, callback) => {
  ecs.listContainerInstances({ cluster: s3Event.cluster}, function(err, data) {
    if (err) callback(err);

    instancesECS = data.containerInstanceArns;

    callback(null, s3Event);
  });
}

const getContainerInstanceDetails = (s3Event, callback) => {
  ecs.describeContainerInstances({containerInstances: instancesECS, cluster: s3Event.cluster}, function(err, data){
    if (err) callback(err);

    data.containerInstances.map(function(instance) {
      instanceMap[instance.ec2InstanceId] = instance.containerInstanceArn;
    });

    callback(null, s3Event);
  });
}

const getServiceArns = (s3Event, callback) => {
  ecs.listServices({ cluster: s3Event.cluster }, function(err, data) {
    if (err) callback(err);

    ecsServiceArns = data.serviceArns;

    callback(null, s3Event);
  });
}

const getServiceDetails = (s3Event, callback) => {
  ecs.describeServices({ services: ecsServiceArns, cluster: s3Event.cluster }, function(err, data) {
    if (err) callback(err);

    data.services.map(function(service) {
      ecsServiceDefinitions.push({
        loadBalancers: service.loadBalancers.map(lb => lb.loadBalancerName),
        desiredCount: service.desiredCount,
        serviceArn: service.serviceArn,
        serviceStatus: service.status
      });
    });

    callback(null, s3Event);
  });
}

const deregisterInstances = (s3Event, callback) => {
  mapInstanceNames(instancesOld).map(function(instanceId){
    forceDeregisterInstance(instanceId);
  });
  callback(null, s3Event);
}

const forceDeregisterInstance = (instanceId, callback) => {
  ecs.deregisterContainerInstance({containerInstance: instanceId, cluster: s3Event.cluster, force: true }, function(err, data) {
    if (err) callback(err);

    callback(null, s3Event);
  });
}

const waitForServices = (s3Event, callback) => {
  ecs.waitFor('servicesStable', {services: ecsServiceArns, cluster: s3Event.cluster}, function(err, data){
    if (err) callback(err);

    callback(null, s3Event);
  });
}

const waitForELBs = (s3Event, callback) => {
  let elbNames = ecsServiceDefinitions.map(service => service.loadBalancers).reduce((a,b) => a.concat(b));

  elbNames.map(function(elb) {
    async.retry({ times: 25, interval: 10 }, checkLoadBalancer(elb), function(err, result) {
      if (err) callback(err);
    });
  });

  callback(null, s3Event);
}

const checkLoadBalancer = (loadBalancer) => {
  elb.describeInstanceHealth({ LoadBalancerName: loadBalancer }, function(err, data){
    if (err) callback(err);

    callback(null, data.InstanceStates.map(instance => instance.State == 'InService').every(elem => elem));
  });
}

const mapInstanceNames = (arr) => arr.map(id => instanceMap[id])
