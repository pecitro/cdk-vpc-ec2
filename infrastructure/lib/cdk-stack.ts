import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as assets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import type { Construct } from "constructs";

interface MyStackProps extends cdk.StackProps {
  envname: string;
}

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MyStackProps) {
    super(scope, id, props);

    const envname = props.envname;

    // VPC作成
    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("192.168.0.0/16"),
      subnetConfiguration: [], // IGW, NATGW, サブネットの自動作成を抑制する
    });

    // インターネットゲートウェイ作成
    const igw = new ec2.CfnInternetGateway(this, "igw", {});
    const igwAttach = new ec2.CfnVPCGatewayAttachment(this, "igw-attach", {
      internetGatewayId: igw.ref,
      vpcId: vpc.vpcId,
    });

    // サブネット作成
    // パブリックサブネット
    // 1aと1cを作成しているのは、ALBの仕様でパブリックサブネットが2個必要なため
    const publicSubnet1a = new ec2.PublicSubnet(this, "PublicSubnet1a", {
      vpcId: vpc.vpcId,
      availabilityZone: "ap-northeast-1a",
      cidrBlock: "192.168.0.0/24",
    });

    const publicSubnet1c = new ec2.PublicSubnet(this, "PublicSubnet1c", {
      vpcId: vpc.vpcId,
      availabilityZone: "ap-northeast-1c",
      cidrBlock: "192.168.1.0/24",
    });

    // プライベートサブネット
    const privateSubnet1a = new ec2.PrivateSubnet(this, "PrivateSubnet1a", {
      vpcId: vpc.vpcId,
      availabilityZone: "ap-northeast-1a",
      cidrBlock: "192.168.10.0/24",
    });

    const privateSubnet1c = new ec2.PrivateSubnet(this, "PrivateSubnet1c", {
      vpcId: vpc.vpcId,
      availabilityZone: "ap-northeast-1c",
      cidrBlock: "192.168.11.0/24",
    });

    // NATゲートウェイ作成
    const eipNatgw = new ec2.CfnEIP(this, "EIP_NATGW", {});
    const natGateway1a = new ec2.CfnNatGateway(this, "NatGateway1a", {
      allocationId: eipNatgw.attrAllocationId,
      subnetId: publicSubnet1a.subnetId,
    });

    // パブリックサブネットにIGWへのルートを追加
    publicSubnet1a.addDefaultInternetRoute(igw.ref, igwAttach);
    publicSubnet1c.addDefaultInternetRoute(igw.ref, igwAttach);

    // プライベートサブネットにNATGWへのルートを追加
    privateSubnet1a.addDefaultNatRoute(natGateway1a.ref);

    // ALB用のセキュリティグループ作成
    const albSg = new ec2.SecurityGroup(this, "albSg", {
      vpc: vpc,
    });

    // ECS用のセキュリティグループ作成
    const ecsSg = new ec2.SecurityGroup(this, "ecsSg", {
      vpc: vpc,
    });

    // // EC2用のセキュリティグループ作成
    // const ec2Sg = new ec2.SecurityGroup(this, "ec2Sg", {
    //   vpc: vpc,
    // });

    // // RDS用のセキュリティグループ作成
    // const rdsSg = new ec2.SecurityGroup(this, "rdsSg", {
    //   vpc: vpc,
    // });

    // // セキュリティグループのポート設定
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "allow http");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "allow https");
    albSg.addEgressRule(ecsSg, ec2.Port.tcp(3000), "allow express port");

    ecsSg.addIngressRule(albSg, ec2.Port.tcp(3000), "allow express port");

    // ALB作成
    const alb = new elbv2.ApplicationLoadBalancer(this, "alb", {
      loadBalancerName: `${envname}-alb`,
      vpc: vpc,
      internetFacing: true,
      vpcSubnets: { subnets: [publicSubnet1a, publicSubnet1c] },
      securityGroup: albSg,
    });

    // ALB用のリスナー作成
    const listener = alb.addListener("listener", {
      port: 80,
      open: true,
    });

    // ALB用のターゲットグループ作成
    const targetGroup = new elbv2.ApplicationTargetGroup(this, "targetGroup", {
      vpc: vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/",
        port: "3000",
        protocol: elbv2.Protocol.HTTP,
        healthyHttpCodes: "200",
        interval: cdk.Duration.seconds(60),
      },
    });
    listener.addTargetGroups("targetGroup", {
      targetGroups: [targetGroup],
    });

    // 参考
    // https://abillyz.com/mamezou/studies/444
    // https://qiita.com/harut_1111/items/93a7b589bc17dfa3598e

    // ECSクラスター作成
    const cluster = new ecs.Cluster(this, "cluster", { vpc: vpc });
    cluster.addCapacity("DefaultAutoScalingGroup", {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.NANO),
      maxCapacity: 1,
      minCapacity: 1,
      vpcSubnets: { subnets: [publicSubnet1a] },
    });

    // ECSタスク定義
    const taskDefinition = new ecs.Ec2TaskDefinition(this, "taskDefinition", {
      networkMode: ecs.NetworkMode.AWS_VPC,
    });

    const dockerImageAsset = new assets.DockerImageAsset(this, "DockerImageAsset", {
      directory: "../docker",
    });
    const container = taskDefinition.addContainer("container", {
      image: ecs.ContainerImage.fromDockerImageAsset(dockerImageAsset),
      memoryLimitMiB: 256,
      cpu: 256,
    });
    container.addPortMappings({
      hostPort: 3000,
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });

    // ECSサービス
    const service = new ecs.Ec2Service(this, "service", {
      cluster: cluster,
      taskDefinition: taskDefinition,
      securityGroups: [ecsSg],
      vpcSubnets: { subnets: [publicSubnet1a] },
    });
    service.attachToApplicationTargetGroup(targetGroup);

    // エラーが出る
    // 2:04:32 AM | CREATE_FAILED        | AWS::ECS::Service                         | serviceService
    // Resource timed out waiting for completion (RequestToken: )

    /*
    service VpcStack-serviceService7DDC3B7C-F6a3465x0zVd was unable to place a task because no container instance met all of its requirements.
    Reason: No Container Instances were found in your cluster.
    For more information, see the Troubleshooting section of the Amazon ECS Developer Guide.
    */

    // // セキュリティグループのポート設定
    // alb.connections.allowFromAnyIpv4(ec2.Port.tcp(80), "allow http");
    // alb.connections.allowFromAnyIpv4(ec2.Port.tcp(443), "allow https");

    // web_ec2.connections.allowFrom(alb, ec2.Port.tcp(3000), "allow express port");

    // web_ec2.addSecurityGroup

    // PostgreSQLへの接続を許可
    // rdsSg.addIngressRule(albSg, ec2.Port.tcp(5432), "allow postgres");
    // rdsSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.allTraffic(), "allow all");

    // // RDS作成
    // // 開発用にシングルAZ構成とする
    // const privateSubnetRds1a = new rds.DatabaseInstance(this, "Rds", {
    //   engine: rds.DatabaseInstanceEngine.postgres({
    //     version: rds.PostgresEngineVersion.VER_16_4,
    //   }),
    //   vpc: vpc,
    //   subnetGroup: new rds.SubnetGroup(this, "PrivateSubnetRds", {
    //     description: "PrivateSubnetRds",
    //     vpc: vpc,
    //     vpcSubnets: {
    //       subnets: [privateSubnet1a, privateSubnet1c],
    //     },
    //   }),
    //   availabilityZone: "ap-northeast-1a",
    //   multiAz: false,
    //   instanceType: ec2.InstanceType.of(
    //     ec2.InstanceClass.T3,
    //     ec2.InstanceSize.MICRO,
    //   ),
    //   removalPolicy: cdk.RemovalPolicy.DESTROY,
    //   securityGroups: [albSg],
    // });
  }
}
