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

    // 参考
    // https://abillyz.com/mamezou/studies/444
    // https://qiita.com/harut_1111/items/93a7b589bc17dfa3598e
    // https://miyahara.hikaru.dev/posts/20191205/

    const envname = props.envname;

    // VPC作成
    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("192.168.0.0/16"),
      // maxAzs: 1,
      subnetConfiguration: [],
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

    // // NATゲートウェイ作成
    // const eipNatgw = new ec2.CfnEIP(this, "EIP_NATGW", {});
    // const natGateway1a = new ec2.CfnNatGateway(this, "NatGateway1a", {
    //   allocationId: eipNatgw.attrAllocationId,
    //   subnetId: publicSubnet1a.subnetId,
    // });

    // パブリックサブネットにIGWへのルートを追加
    publicSubnet1a.addDefaultInternetRoute(igw.ref, igwAttach);
    publicSubnet1c.addDefaultInternetRoute(igw.ref, igwAttach);

    // // プライベートサブネットにNATGWへのルートを追加
    // privateSubnet1a.addDefaultNatRoute(natGateway1a.ref);

    // ALB用のセキュリティグループ作成
    const albSg = new ec2.SecurityGroup(this, "albSg", {
      vpc: vpc,
    });

    // ECS用のセキュリティグループ作成
    const ecsSg = new ec2.SecurityGroup(this, "ecsSg", {
      vpc: vpc,
    });

    // // RDS用のセキュリティグループ作成
    // const rdsSg = new ec2.SecurityGroup(this, "rdsSg", {
    //   vpc: vpc,
    // });

    // // セキュリティグループのポート設定
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "allow http");
    albSg.addEgressRule(ecsSg, ec2.Port.tcp(80), "allow http");
    ecsSg.addIngressRule(albSg, ec2.Port.tcp(80), "allow http");

    // ECSクラスター作成
    const cluster = new ecs.Cluster(this, "ecsCluster", {
      vpc: vpc,
    });

    // ECSタスクの定義
    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef", {
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      cpu: 1024,
      memoryLimitMiB: 4096,
    });

    // ECSタスクの詳細設定
    taskDefinition.addContainer("DefaultContainer", {
      containerName: "hello-world",
      image: ecs.ContainerImage.fromDockerImageAsset(
        new assets.DockerImageAsset(this, "DockerImageAsset", { directory: "../docker" }),
      ),
      portMappings: [
        {
          name: "http-port",
          containerPort: 80,
          appProtocol: ecs.AppProtocol.http,
        },
      ],
    });

    // ECSのサービスの定義
    const ecsService = new ecs.FargateService(this, "Service", {
      cluster: cluster,
      taskDefinition: taskDefinition,
      desiredCount: 1,
      // assignPublicIp: true,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      vpcSubnets: { subnets: [privateSubnet1a] },
      securityGroups: [ecsSg],
    });
    // https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs.EcsTarget.html

    // ALB作成
    const alb = new elbv2.ApplicationLoadBalancer(this, "alb", {
      loadBalancerName: `${envname}-alb`,
      vpc: vpc,
      internetFacing: true,
      vpcSubnets: { subnets: [publicSubnet1a, publicSubnet1c] },
      securityGroup: albSg,
    });

    // ALB用のターゲットグループ作成
    const targetGroup = new elbv2.ApplicationTargetGroup(this, "targetGroup", {
      vpc: vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [ecsService],
    });

    // ALB用のリスナー作成
    const listener = alb.addListener("listener", { port: 80 });
    listener.addTargetGroups("targetGroup", { targetGroups: [targetGroup] });

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
