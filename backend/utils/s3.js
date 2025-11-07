const AWS = require('aws-sdk');
const path = require('path');
const fs = require('fs');

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

async function uploadFileToS3(localFilePath, s3Folder = '') {
  const fileContent = fs.readFileSync(localFilePath);
  const fileName = path.basename(localFilePath);
  const s3Key = s3Folder ? `${s3Folder}/${fileName}` : fileName;

  const params = {
    Bucket: process.env.AWS_S3_BUCKET,
    Key: s3Key,
    Body: fileContent,
    ACL: 'public-read'
  };

  await s3.upload(params).promise();
  return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;
}

module.exports = { uploadFileToS3 };
