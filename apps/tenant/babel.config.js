module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    overrides: [
      {
        // @orpc/client uses a destructured rest parameter, which Hermes cannot parse; Expo's
        // Hermes profile skips this transform, so apply it to those packages only.
        // A function, because Metro also loads this config without a filename.
        test: (filename) =>
          typeof filename === 'string' && /node_modules[\\/]\.pnpm[\\/]@orpc\+/.test(filename),
        plugins: ['@babel/plugin-transform-parameters'],
      },
    ],
  };
};
