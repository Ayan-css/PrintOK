#!/usr/bin/env bash
set -e

echo "============================================="
echo "   PrintOk — Developer Workspace Setup Script"
echo "============================================="

# 1. Environment file setup
if [ ! -f .env ]; then
  echo "--> Copying .env.example to .env..."
  cp .env.example .env
else
  echo "--> .env already exists, skipping copy."
fi

# 2. Install root and workspace dependencies
echo "--> Installing Node.js dependencies..."
npm install

# 3. Build shared packages
echo "--> Building @printok/shared-types..."
npm run build --workspace=@printok/shared-types

# 4. Generate Prisma Client
echo "--> Generating Prisma Client for @printok/api..."
cd services/api
npx prisma generate
cd ../..

# 5. Build API and Web
echo "--> Building API..."
npm run build --workspace=@printok/api

echo "--> Building Customer Web..."
npm run build --workspace=@printok/customer-web

echo "============================================="
echo "   ✅ Setup Complete!"
echo "   Start API:       cd services/api && npm run dev"
echo "   Start Web:       cd apps/customer-web && npm start"
echo "   Run Integration: cd services/api && npm test"
echo "   Run .NET Agent:  dotnet run --project agent/windows-print-agent"
echo "============================================="
