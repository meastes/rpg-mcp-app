import type { StorybookConfig } from "@storybook/react-vite";
import tsconfigPaths from "vite-tsconfig-paths";

const config: StorybookConfig = {
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: [
    "@storybook/addon-essentials",
  ],
  viteFinal: async (config) => {
    config.plugins = config.plugins ?? [];
    config.plugins.push(tsconfigPaths());
    return config;
  },
};

export default config;
