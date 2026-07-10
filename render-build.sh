#!/bin/bash

echo "Starting build process..."

# Install dependencies
npm install

# Install Chrome for Puppeteer
npx puppeteer browsers install chrome

echo "Build completed!"
