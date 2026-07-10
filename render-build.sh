#!/bin/bash

echo "🚀 Starting build process..."

# Install dependencies
npm install

# Install Chrome version 121 (compatible with what's being installed)
npx puppeteer browsers install chrome@121.0.6167.85

echo "✅ Build completed!"
