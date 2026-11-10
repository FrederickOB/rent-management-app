// Expo configures Metro for monorepos (watch folders, node_modules resolution) by default.
const { getDefaultConfig } = require('expo/metro-config');
const { resolveTrimmed } = require('./metro.trim');

const config = getDefaultConfig(__dirname);

// M11 decision 8: modules the app never uses are left out of the bundle (metro.trim.js).
const resolveDefault = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) =>
  resolveTrimmed(
    context,
    (resolveDefault ?? context.resolveRequest)(context, moduleName, platform),
  );

module.exports = config;
