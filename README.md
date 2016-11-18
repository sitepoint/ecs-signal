# ECS Instance rotation
Rotating instances in ECS is surprisingly painful. If your instances are part of an AutoScaling Group, rotating the instances here will not keep your ECS Services running. CloudFormation however allows us to define a [Custom Resource](http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cfn-customresource.html) that can trigger a Lambda function, and from this function we can query various services to ensure service stability remains.

## Setup

Create the following resources. The Lambda function doesn't need to be in the same stack as your ECS Cluster, but the Custom resource does.

```yaml
  ECSUpdateTrigger:
    Type: Custom::ECSUpdateTrigger
    Properties:
      ServiceToken: !GetAtt SolveECSUpdateLambda.Arn
      StackName: !Ref AWS::StackName
      AutoScalingGroup: !Ref AutoScalingGroup
      ECSCluster: !Ref ECSCluster

  SolveECSUpdateLambda:
    Type: AWS::Lambda::Function
    Properties:
      Code:
        S3Bucket: bucket-name
        S3Key: ecs-signal.zip
      Handler: index.handler
      Runtime: nodejs4.3
      Timeout: 300
      Role: !Ref ECSLambdaExecutionRole

  ECSLambdaExecutionRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal:
              Service:
                - lambda.amazonaws.com
            Action:
              - sts:AssumeRole
      Path: "/"
      Policies:
        - PolicyName: root
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action:
                  - autoscaling:DescribeAutoScalingGroups
                  - ecs:DeregisterContainerInstance
                  - ecs:DescribeContainerInstances
                  - ecs:DescribeServices
                  - ecs:ListContainerInstances
                  - ecs:ListServices
                  - elasticloadbalancing:DescribeInstanceHealth
                  - elasticloadbalancing:DescribeTargetHealth
                Resource: "*"
        - PolicyName: CloudWatchLogsAccess
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action:
                  - logs:*
                Resource: arn:aws:logs:*:*:*
```

## Operation
Given a cluster and ASG name, the function will first get all services that are running on the old cluster. It will then query the new cluster and wait for these services to reach a ready state. If there are any attached load balancers, either ELB Classic or Application Load Balancers, these will also be queried until all attached containers have reached an InService state.

## Why is this needed?
Rotating the instances in an AutoScaling Group is something that needs to happen from time to time. However, the ASG has no understanding of what is running on it, and will happily remove an old ASG once it has gotten the success signal from all new instances.

ECS doesn't have the ability to specify which instance a service will run on, meaning it is not possible to ask it to move all services from one set of servers to another. Therefor, some assistance is required.

## Can I update the ASG without creating a new Cluster?
No. Don't do this.

## How come?
Because you cannot specify which instances a service will run on, the new ASG will spin up and ECS will not schedule any services to run on it. Creating a new Cluster and scheduling services to run on the cluster is the only way at present to achieve this.

## OK, what about a new Cluster without a new ASG?
No. Don't do this either

## Damnit why not?
The new cluster will be created, services will be created for it but no instances will be put into it.

The bottom line is, whenever you update your LaunchConfiguration and therefor create a new AutoScaling Group, you _need_ a new Cluster.
