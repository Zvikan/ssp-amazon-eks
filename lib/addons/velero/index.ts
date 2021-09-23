import { ClusterAddOn, ClusterInfo } from "../../spi";
import { Constants } from "..";
import { Construct } from "@aws-cdk/core";
import * as s3 from "@aws-cdk/aws-s3";
import * as iam from "@aws-cdk/aws-iam";
import { HelmChart } from "@aws-cdk/aws-eks";
import merge from "ts-deepmerge";
import { createNamespace } from "../../utils";

/**
 * Configuration options for the add-on.
 */
export interface VeleroAddOnProps {
    /**
     * Velero for the Velero Helm Chart.
     * @default 2.23.6
     */
    version?: string;
   
    /**
     * Namespace for the Velero add-on. If the namespace does not exist, it will be created by the addon with the default namespace value.
     * @default 
     *      namespace:{
     *        name: "velero",
     *        create: true    
     *      }
     */
    namespace?: {
        name: string,   // default value is "velero", if it is specified then it will be the namespace of where velero is deployed to.
        create: boolean // default is true, if it is false, no new namespace will be created
    };

     /**
     * Values to pass to the chart as per https://github.com/vmware-tanzu/helm-charts/blob/main/charts/velero/values.yaml#
     * Required if provided.
     */
    values: {
        [key: string]: any;
    };

}

/**
 * Defaults options for the add-on
 */
const defaultProps: VeleroAddOnProps = {
    version: "2.23.6",
    namespace: {
        name: "velero",
        create: true
    },
    values:{
        initContainers:[
            {
                name: "velero-plugin-for-aws",
                image: "velero/velero-plugin-for-aws:v1.2.0",
                imagePullPolicy: "IfNotPresent",
                volumeMounts:[
                    {
                        mountPath: "/target",
                        name: "plugins"
                    }
                ]
            }
        ],
        configuration: {
            provider: "aws",
            backupStorageLocation:{
                name: "default",
                config:{}
            },
            volumeSnapshotLocation:{
                name: "default",
                config:{}
            },
        },
        serviceAccount: {
            server:{}
        }
    },

};

export class VeleroAddOn implements ClusterAddOn {

    private options: VeleroAddOnProps;
    private chartNode: HelmChart;
    constructor(props?: VeleroAddOnProps) {
        if (props) {
            // merge the nested json files
            this.options = merge(defaultProps, props);
        }
        else {
            this.options = defaultProps
        }
    }

    /**
     * Implementation of the add-on contract deploy method.
    */
    async deploy(clusterInfo: ClusterInfo): Promise<Construct> {
        const cluster = clusterInfo.cluster;
        const props = this.options;
               
        // Create S3 bucket if no existing bucket, create s3 bucket and corresponding KMS key
        const bucketName = this.returnS3BucketName(clusterInfo, "backup-bucket", props.values.configuration.backupStorageLocation.bucket)

        // Create Namespace if namespace is not explicied defined.
        const veleroNamespace = this.createNamespaceIfNeeded(clusterInfo, "velero", props.namespace);

        // Setup IAM Role for Service Accounts (IRSA) for the Velero Service Account
        const veleroServiceAccountName = this.createIRSA(clusterInfo, "velero-account", veleroNamespace, bucketName)
        
        // Setup the values for the helm chart
        const valueVariable: VeleroAddOnProps = {
            values: {
                configuration: {
                    backupStorageLocation: {
                        prefix: props.values.configuration.backupStorageLocation.prefix ?? "velero/" + cluster.clusterName,
                        bucket: bucketName,
                        config:{
                           region: props.values.configuration.backupStorageLocation.config.region ?? cluster.stack.region,
                        }
                    },
                    volumeSnapshotLocation:{
                        config:{
                            region: props.values.configuration.backupStorageLocation.config.region ?? cluster.stack.region
                        }
                    }
                },
                // IAM role for Service Account
                serviceAccount: {
                    server: {
                        create: false,
                        name: veleroServiceAccountName,    
                    }
                }             
            }
        };

        const values = merge(props.values, valueVariable.values) ?? {}; 
 
        this.chartNode = cluster.addHelmChart("velero-addon", {
            chart: "velero",
            repository: "https://vmware-tanzu.github.io/helm-charts/",
            release: Constants.SSP_ADDON,
            namespace: veleroNamespace,
            version: props.version,
            values: values
        });
        return this.chartNode;
    }

    /**
     * Return S3 Bucket
     * @param clusterInfo 
     * @param id S3-Bucket-Postfix 
     * @param existingBucketName exiting provided S3 BucketName if it exists 
     * @returns the existing provided S3 bucket name or the newly created S3 bucket name
     */
    protected returnS3BucketName(clusterInfo: ClusterInfo, id: string, existingBucketName: null|string ): string {
        if (!existingBucketName){
            const bucket = new s3.Bucket(clusterInfo.cluster, "velero-${id}", {
                encryption: s3.BucketEncryption.KMS_MANAGED, // Velero Known bug for support with S3 with SSE-KMS with CMK, thus it does not support S3 Bucket Key: https://github.com/vmware-tanzu/helm-charts/issues/83
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // Block Public Access for S3
                publicReadAccess: false,
                enforceSSL: true // Encryption in Transit
            });
            return bucket.bucketName;
        }
        else {
            return existingBucketName;
        }
    }

    /**
     * Return Velero Namespace where Velero will be installed onto
     * @param clusterInfo
     * @param defaultName the Default Namespace for Velero if nothing specified 
     * @param namespace
     * @returns the namespace created or existed.
     */
    protected createNamespaceIfNeeded(clusterInfo: ClusterInfo, defaultName: string, namespace?: {name: string, create: boolean}): string {
        // Create Namespace if namespace is not explicied defined.
        if (namespace){
            // Create Namespace if the "create" option is true
            if (namespace.create) {
                createNamespace(namespace.name, clusterInfo.cluster);
            }
            // If the "create" option if false, then namespace will not be created, return namespace.name
            return namespace.name;
        }
        else{
            return defaultName; // initial value of veleroNamespace
        }
    }

    /**
     * Return Velero Namespace where Velero will be installed onto
     * @param clusterInfo
     * @param id
     * @param namespace Velero namespace name
     * @param s3BucketName the S3 BucketName where Velero will stores the backup onto
     * @returns the service Account Name
     */
    protected createIRSA(clusterInfo: ClusterInfo, id: string, namespace: string, s3BucketName: string): string {
        // Setup IAM Role for Service Accounts (IRSA) for the Velero Service Account
        const veleroServiceAccount = clusterInfo.cluster.addServiceAccount (
            id,
            {
                name: id,
                namespace: namespace
            }
        );

        // Extract S3 bucket object via the bucket name in order to use it in the IAM policy document. 
        const s3bucket = s3.Bucket.fromBucketName(clusterInfo.cluster, "S3Bucket", s3BucketName);
        // IAM policy for Velero
        const veleroPolicyDocument = {
            "Version": "2012-10-17",
            "Statement": [
              {
                  "Effect": "Allow",
                  "Action": [
                      "ec2:DescribeVolumes",
                      "ec2:DescribeSnapshots",
                      "ec2:CreateTags",
                      "ec2:CreateVolume",
                      "ec2:CreateSnapshot",
                      "ec2:DeleteSnapshot"
                  ],
                  "Resource": "*"
              },
              {
                "Effect": "Allow",
                "Action": [
                    "s3:GetObject",
                    "s3:DeleteObject",
                    "s3:PutObject",
                    "s3:AbortMultipartUpload",
                    "s3:ListMultipartUploadParts",
                    "s3:ListBucket"
                ],
                "Resource": [
                    s3bucket.arnForObjects("*"),
                    s3bucket.bucketArn                   
                ]
              }
            ]
        };

        const veleroCustomPolicyDocument = iam.PolicyDocument.fromJson(veleroPolicyDocument);
        const veleroPolicy = new iam.ManagedPolicy(clusterInfo.cluster, "velero-managed-policy", {
            document: veleroCustomPolicyDocument
        });
        veleroServiceAccount.role.addManagedPolicy(veleroPolicy);
        return veleroServiceAccount.serviceAccountName
    }
}