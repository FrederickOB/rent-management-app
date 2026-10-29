// Expo configures Metro for monorepos (watch folders, node_modules resolution) by default.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
