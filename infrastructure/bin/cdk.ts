import * as cdk from "aws-cdk-lib";
import { CdkStack } from "../lib/cdk-stack";
import { envname } from "./config";

const app = new cdk.App();

// CDK Stack
new CdkStack(app, "VpcStack", {
  env: { region: "ap-northeast-1" },
  envname: envname,
});
