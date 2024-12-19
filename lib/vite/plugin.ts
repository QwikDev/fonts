import type { ESBuildOptions, Plugin } from "vite";
import { FontlessOptions, Options } from "../types";
import { transform } from "esbuild";
import type { TransformOptions } from "esbuild";
import { transformCSS } from "../css/transformer";
import { providers } from "unifont";
import local from "../providers/local";

const defaultModule = {
  devtools: true,
  experimental: {
    processCSSVariables: false,
    disableLocalFallbacks: false,
  },
  defaults: {},
  assets: {
    prefix: "/_fonts",
  },
  local: {},
  google: {},
  adobe: {
    id: "",
  },
  providers: {
    // should import with Jiti
    local,
    adobe: providers.adobe,
    google: providers.google,
    googleicons: providers.googleicons,
    bunny: providers.bunny,
    fontshare: providers.fontshare,
    fontsource: providers.fontsource,
  },
};

const defaultFontless: FontlessOptions = {
  dev: false,
  processCSSVariables: false,
  shouldPreload: () => false,
  fontsToPreload: new Map(),
};

const defaultOptions = {
  module: defaultModule,
  fontless: defaultFontless,
};

function resolveMinifyCssEsbuildOptions(
  options: ESBuildOptions
): TransformOptions {
  const base: TransformOptions = {
    charset: options.charset ?? "utf8",
    logLevel: options.logLevel,
    logLimit: options.logLimit,
    logOverride: options.logOverride,
    legalComments: options.legalComments,
  };

  if (
    options.minifyIdentifiers != null ||
    options.minifySyntax != null ||
    options.minifyWhitespace != null
  ) {
    return {
      ...base,
      minifyIdentifiers: options.minifyIdentifiers ?? true,
      minifySyntax: options.minifySyntax ?? true,
      minifyWhitespace: options.minifyWhitespace ?? true,
    };
  }

  return { ...base, minify: true };
}

export const fontless = (options: Options = defaultOptions): Plugin => {
  const { fontless } = options;
  let postcssOptions: Parameters<typeof transform>[1] | undefined;

  return {
    name: "vite-plugin-fontless",
    configResolved(config) {
      if (fontless.dev || !config.esbuild || postcssOptions) {
        return;
      }

      postcssOptions = {
        target: config.esbuild.target ?? "chrome",
        ...resolveMinifyCssEsbuildOptions(config.esbuild),
      };
    },
    renderChunk(_code, chunk) {
      if (chunk.facadeModuleId) {
        for (const file of chunk.moduleIds) {
          if (fontless.fontsToPreload.has(file)) {
            fontless.fontsToPreload.set(
              chunk.facadeModuleId,
              fontless.fontsToPreload.get(file)!
            );
          }
        }
      }
    },
    async transform(code, id) {
      // Early return if no font-family is used in this CSS
      if (!fontless.processCSSVariables && !code.includes("font-family:")) {
        return;
      }

      const s = await transformCSS(options, code, id, postcssOptions);

      if (s.hasChanged()) {
        return {
          code: s.toString(),
          map: s.generateMap({ hires: true }),
        };
      }
    },
  };
};
