#!/bin/bash

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install --prefix . pngjs
fi

# Run the test
echo "Running matching test..."
node test-matching-node.js