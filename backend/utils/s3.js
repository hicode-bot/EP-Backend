const cloudinary = require('cloudinary').v2;
const path = require('path');
const fs = require('fs');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function uploadFileToCloudinary(localFilePath, folder = '') {
  const fileContent = fs.readFileSync(localFilePath);
  const fileName = path.basename(localFilePath);
  const cloudinaryFolder = folder ? `${folder}/` : '';

  const result = await cloudinary.uploader.upload(localFilePath, {
    folder: cloudinaryFolder,
    public_id: fileName,
    resource_type: 'auto'
  });

  return result.secure_url;
}

module.exports = { uploadFileToCloudinary };
