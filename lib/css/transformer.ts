import { transform } from "esbuild";
import { createJiti } from "jiti";
import MagicString from "magic-string";
import { parse, walk } from "css-tree";
import { dirname, extname } from "pathe";
import { hasProtocol, withLeadingSlash } from "ufo";
import {
  createUnifont,
  FontFaceData,
  Provider,
  RemoteFontSource,
} from "unifont";
import {
  GenericCSSFamily,
  extractFontFamilies,
  extractGeneric,
  extractEndOfFirstChild,
  addLocalFallbacks,
} from "./parse";
import {
  formatToExtension,
  generateFontFace,
  generateFontFallbacks,
  parseFont,
  relativiseFontSources,
} from "./render";
import { hash } from "ohash";
import { filename } from "pathe/utils";
import {
  ModuleOptions,
  RawFontFaceData,
  FontFamilyManualOverride,
  FontFamilyProviderOverride,
  Options,
  FontFaceResolution,
} from "../types";

const defaultValues = {
  weights: [400],
  styles: ["normal", "italic"] as const,
  subsets: [
    "cyrillic-ext",
    "cyrillic",
    "greek-ext",
    "greek",
    "vietnamese",
    "latin-ext",
    "latin",
  ],
  fallbacks: {
    serif: ["Times New Roman"],
    "sans-serif": ["Arial"],
    monospace: ["Courier New"],
    cursive: [],
    fantasy: [],
    "system-ui": [
      "BlinkMacSystemFont",
      "Segoe UI",
      "Roboto",
      "Helvetica Neue",
      "Arial",
    ],
    "ui-serif": ["Times New Roman"],
    "ui-sans-serif": ["Arial"],
    "ui-monospace": ["Courier New"],
    "ui-rounded": [],
    emoji: [],
    math: [],
    fangsong: [],
  },
} satisfies ModuleOptions["defaults"];

async function defaultResolveFontFace(
  options: Options,
  fontFamily,
  fallbackOptions
) {
  const { module } = options;
  const override = module.families?.find((f) => f.name === fontFamily);

  // This CSS will be injected in a separate location
  if (override?.global) {
    return;
  }

  function addFallbacks(fontFamily: string, font: FontFaceData[]) {
    if (module.experimental?.disableLocalFallbacks) {
      return font;
    }
    return addLocalFallbacks(fontFamily, font);
  }

  function normalizeFontData(
    faces: RawFontFaceData | FontFaceData[]
  ): FontFaceData[] {
    // const assetsBaseURL = module.assets.prefix || "/fonts"; //TODO: Review this if it's necessary?
    // const renderedFontURLs = new Map<string, string>(); //TODO: Review this if it's necessary?
    const data: FontFaceData[] = [];
    for (const face of Array.isArray(faces) ? faces : [faces]) {
      data.push({
        ...face,
        unicodeRange:
          face.unicodeRange === undefined || Array.isArray(face.unicodeRange)
            ? face.unicodeRange
            : [face.unicodeRange],
        src: (Array.isArray(face.src) ? face.src : [face.src]).map((src) => {
          const source = typeof src === "string" ? parseFont(src) : src;
          if (
            "url" in source &&
            hasProtocol(source.url, { acceptRelative: true })
          ) {
            source.url = source.url.replace(/^\/\//, "https://");
            const file = [
              // TODO: investigate why negative ignore pattern below is being ignored
              filename(source.url.replace(/\?.*/, "")).replace(/^-+/, ""),
              hash(source) +
                (extname(source.url) || formatToExtension(source.format) || ""),
            ]
              .filter(Boolean)
              .join("-");

            // renderedFontURLs.set(file, source.url); //TODO: Review this if it's necessary?
            source.originalURL = source.url;
            // source.url = joinURL(assetsBaseURL, file); //TODO: Review this if it's necessary?
          }
          return source;
        }),
      });
    }
    return data;
  }

  async function resolveFontFaceWithOverride(
    fontFamily: string,
    override?: FontFamilyManualOverride | FontFamilyProviderOverride,
    fallbackOptions?: { fallbacks: string[]; generic?: GenericCSSFamily }
  ): Promise<FontFaceResolution | undefined> {
    const normalizedDefaults = {
      weights: (module.defaults?.weights || defaultValues.weights).map((v) =>
        String(v)
      ),
      styles: module.defaults?.styles || defaultValues.styles,
      subsets: module.defaults?.subsets || defaultValues.subsets,
      fallbacks: Object.fromEntries(
        Object.entries(defaultValues.fallbacks).map(([key, value]) => [
          key,
          Array.isArray(module.defaults?.fallbacks)
            ? module.defaults.fallbacks
            : module.defaults?.fallbacks?.[key as GenericCSSFamily] || value,
        ])
      ) as Record<GenericCSSFamily, string[]>,
    };

    const fallbacks =
      normalizedDefaults.fallbacks[fallbackOptions?.generic || "sans-serif"];

    if (override && "src" in override) {
      const fonts = addFallbacks(
        fontFamily,
        normalizeFontData({
          src: override.src,
          display: override.display,
          weight: override.weight,
          style: override.style,
        })
      );

      return {
        fallbacks,
        fonts,
      };
    }

    // Respect fonts that should not be resolved through `@nuxt/fonts`
    if (override?.provider === "none") {
      return;
    }

    // Respect custom weights, styles and subsets options
    const defaults = { ...normalizedDefaults, fallbacks };
    for (const key of ["weights", "styles", "subsets"] as const) {
      if (override?.[key]) {
        defaults[key as "weights"] = override[key]!.map((v) => String(v));
      }
    }

    const providers = await resolveProviders(module.providers);
    const prioritisedProviders = new Set<string>();
    const resolvedProviders: Array<Provider> = [];
    for (const [key, provider] of Object.entries(providers)) {
      if (
        module.providers?.[key] === false ||
        (module.provider && module.provider !== key)
      ) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete providers[key];
      } else {
        //TODO: Fix this type
        const providerOptions: any =
          module[key as "google" | "local" | "adobe"] ?? {};
        resolvedProviders.push(provider(providerOptions));
      }
    }

    for (const val of module.priority || []) {
      if (val in providers) prioritisedProviders.add(val);
    }
    for (const provider in providers) {
      prioritisedProviders.add(provider);
    }

    const unifont = await createUnifont(resolvedProviders);

    // Handle explicit provider
    if (override?.provider) {
      if (override.provider in providers) {
        const result = await unifont.resolveFont(fontFamily, defaults, [
          override.provider,
        ]);
        // Rewrite font source URLs to be proxied/local URLs
        const fonts = normalizeFontData(result?.fonts || []);
        if (!fonts.length || !result) {
          console.warn(
            `Could not produce font face declaration from \`${override.provider}\` for font family \`${fontFamily}\`.`
          );
          return;
        }
        const fontsWithLocalFallbacks = addFallbacks(fontFamily, fonts);

        return {
          fallbacks: result.fallbacks || defaults.fallbacks,
          fonts: fontsWithLocalFallbacks,
        };
      }
    }

    const result = await unifont.resolveFont(fontFamily, defaults, [
      ...prioritisedProviders,
    ]);
    if (result) {
      // Rewrite font source URLs to be proxied/local URLs
      const fonts = normalizeFontData(result.fonts);
      if (fonts.length > 0) {
        const fontsWithLocalFallbacks = addFallbacks(fontFamily, fonts);

        return {
          fallbacks: result.fallbacks || defaults.fallbacks,
          fonts: fontsWithLocalFallbacks,
        };
      }
      if (override) {
        console.warn(
          `Could not produce font face declaration for \`${fontFamily}\` with override.`
        );
      }
    }
  }

  return resolveFontFaceWithOverride(fontFamily, override, fallbackOptions);
}

export async function transformCSS(
  options: Options,
  code: string,
  id: string,
  postcssOptions: Parameters<typeof transform>[1],
  opts: { relative?: boolean } = {}
) {
  const { fontless } = options;
  const s = new MagicString(code);

  const injectedDeclarations = new Set<string>();

  const promises = [] as Promise<unknown>[];

  const ast = parse(code, { positions: true });

  // Collect existing `@font-face` declarations (to skip adding them)
  const existingFontFamilies = new Set<string>();

  async function addFontFaceDeclaration(
    fontFamily: string,
    fallbackOptions?: {
      generic?: GenericCSSFamily;
      fallbacks: string[];
      index: number;
    }
  ) {
    const resolved = await defaultResolveFontFace(options, fontFamily, {
      generic: fallbackOptions?.generic,
      fallbacks: fallbackOptions?.fallbacks || [],
    });
    const result = resolved || {};

    if (!result.fonts || result.fonts.length === 0) return;

    const fallbackMap =
      result.fallbacks?.map((f) => ({
        font: f,
        name: `${fontFamily} Fallback: ${f}`,
      })) || [];
    let insertFontFamilies = false;

    if (
      result.fonts[0] &&
      fontless.shouldPreload(fontFamily, result.fonts[0])
    ) {
      const fontToPreload = result.fonts[0].src.find(
        (s): s is RemoteFontSource => "url" in s
      )?.url;
      if (fontToPreload) {
        const urls = fontless.fontsToPreload.get(id) || new Set();
        fontless.fontsToPreload.set(id, urls.add(fontToPreload));
      }
    }

    const prefaces: string[] = [];

    for (const font of result.fonts) {
      const fallbackDeclarations = await generateFontFallbacks(
        fontFamily,
        font,
        fallbackMap
      );
      const declarations = [
        generateFontFace(
          fontFamily,
          opts.relative
            ? relativiseFontSources(font, withLeadingSlash(dirname(id)))
            : font
        ),
        ...fallbackDeclarations,
      ];

      for (let declaration of declarations) {
        if (!injectedDeclarations.has(declaration)) {
          injectedDeclarations.add(declaration);
          if (!fontless.dev) {
            declaration = await transform(declaration, {
              charset: "utf8",
              minify: true,
              ...postcssOptions,
            })
              .then((r) => r.code || declaration)
              .catch(() => declaration);
          } else {
            declaration += "\n";
          }
          prefaces.push(declaration);
        }
      }

      // Add font family names for generated fallbacks
      if (fallbackDeclarations.length) {
        insertFontFamilies = true;
      }
    }

    s.prepend(prefaces.join(""));

    if (fallbackOptions && insertFontFamilies) {
      const insertedFamilies = fallbackMap.map((f) => `"${f.name}"`).join(", ");
      s.prependLeft(fallbackOptions.index, `, ${insertedFamilies}`);
    }
  }

  // For nested CSS we need to keep track how long the parent selector is
  function processNode(node: CssNode, parentOffset = 0) {
    walk(node, {
      visit: "Declaration",
      enter(node) {
        if (
          this.atrule?.name === "font-face" &&
          node.property === "font-family"
        ) {
          for (const family of extractFontFamilies(node)) {
            existingFontFamilies.add(family);
          }
        }
      },
    });

    walk(node, {
      visit: "Declaration",
      enter(node) {
        if (
          (node.property !== "font-family" &&
            node.property !== "font" &&
            (!fontless.processCSSVariables ||
              !node.property.startsWith("--"))) ||
          this.atrule?.name === "font-face"
        ) {
          return;
        }

        // Only add @font-face for the first font-family in the list and treat the rest as fallbacks
        const [fontFamily, ...fallbacks] = extractFontFamilies(node);
        if (fontFamily && !existingFontFamilies.has(fontFamily)) {
          promises.push(
            addFontFaceDeclaration(
              fontFamily,
              node.value.type !== "Raw"
                ? {
                    fallbacks,
                    generic: extractGeneric(node),
                    index: extractEndOfFirstChild(node)! + parentOffset,
                  }
                : undefined
            )
          );
        }
      },
    });

    // Process nested CSS until `css-tree` supports it: https://github.com/csstree/csstree/issues/268#issuecomment-2417963908
    walk(node, {
      visit: "Raw",
      enter(node) {
        const nestedRaw = parse(node.value, {
          positions: true,
        }) as StyleSheet;
        const isNestedCss = nestedRaw.children.some(
          (child) => child.type === "Rule"
        );
        if (!isNestedCss) return;
        parentOffset += node.loc!.start.offset;
        processNode(nestedRaw, parentOffset);
      },
    });
  }

  processNode(ast);

  await Promise.all(promises);

  return s;
}

async function resolveProviders(_providers: ModuleOptions["providers"] = {}) {
  const jiti = createJiti("/");

  const providers = { ..._providers };
  for (const key in providers) {
    const value = providers[key];
    if (value === false) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete providers[key];
    }
    if (typeof value === "string") {
      providers[key] = await jiti.import(value, {
        default: true,
      });
    }
  }
  return providers as Record<string, (options: any) => Provider>;
}
