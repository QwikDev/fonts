import type { ESBuildOptions, Plugin } from "vite";
import { RemoteFontSource } from "unifont";
import { parse, walk, type CssNode } from "css-tree";
import { extractEndOfFirstChild, extractFontFamilies, extractGeneric, GenericCSSFamily } from "../css/parse";
import { Awaitable, FontFaceData } from "../types";
import { generateFontFace, generateFontFallbacks, relativiseFontSources } from "../css/render";
import { dirname } from "pathe";
import { withLeadingSlash } from "ufo";
import { transform } from "esbuild";
import type { TransformOptions } from "esbuild";
import MagicString from "magic-string";

export interface FontFaceResolution {
	fonts?: FontFaceData[]
	fallbacks?: string[]
  }

// FontFamilyInjectionPluginOptions in nuxt fonts
interface FontlessOptions {
	resolveFontFace: (fontFamily: string, fallbackOptions?: { fallbacks: string[], generic?: GenericCSSFamily }) => Awaitable<undefined | FontFaceResolution>
	processCSSVariables?: boolean
	shouldPreload: (fontFamily: string, font: FontFaceData) => boolean
	fontsToPreload: Map<string, Set<string>>
  }

export function fontless(options: FontlessOptions): Plugin {
	let postcssOptions: Parameters<typeof transform>[1] | undefined;
	let isDev: boolean;
	async function transformCSS(code: string, id: string, opts: { relative?: boolean } = {}) {
		const s = new MagicString(code)

		const ast = parse(code, { positions: true });
		const existingFontFamilies = new Set<string>();
		const promises = [] as Promise<unknown>[];
		const injectedDeclarations = new Set<string>()

		async function addFontFaceDeclaration(fontFamily: string, fallbackOptions?: {
			generic?: GenericCSSFamily
			fallbacks: string[]
			index: number
		  }) {
			const result = await options.resolveFontFace(fontFamily, {
			  generic: fallbackOptions?.generic,
			  fallbacks: fallbackOptions?.fallbacks || [],
			}) || {}
	  
			if (!result.fonts || result.fonts.length === 0) return
	  
			const fallbackMap = result.fallbacks?.map(f => ({ font: f, name: `${fontFamily} Fallback: ${f}` })) || []
			let insertFontFamilies = false
	  
			if (result.fonts[0] && options.shouldPreload(fontFamily, result.fonts[0])) {
			  const fontToPreload = result.fonts[0].src.find((s): s is RemoteFontSource => 'url' in s)?.url
			  if (fontToPreload) {
				const urls = options.fontsToPreload.get(id) || new Set()
				options.fontsToPreload.set(id, urls.add(fontToPreload))
			  }
			}
	  
			const prefaces: string[] = []
	  
			for (const font of result.fonts) {
			  const fallbackDeclarations = await generateFontFallbacks(fontFamily, font, fallbackMap)
			  const declarations = [generateFontFace(fontFamily, opts.relative ? relativiseFontSources(font, withLeadingSlash(dirname(id))) : font), ...fallbackDeclarations]
	  
			  for (let declaration of declarations) {
				if (!injectedDeclarations.has(declaration)) {
				  injectedDeclarations.add(declaration)
				  if (!isDev) {
					declaration = await transform(declaration, {
					  loader: 'css',
					  charset: 'utf8',
					  minify: true,
					  ...postcssOptions,
					}).then(r => r.code || declaration).catch(() => declaration)
				  }
				  else {
					declaration += '\n'
				  }
				  prefaces.push(declaration)
				}
			  }
	  
			  // Add font family names for generated fallbacks
			  if (fallbackDeclarations.length) {
				insertFontFamilies = true
			  }
			}
	  
			s.prepend(prefaces.join(''))
	  
			if (fallbackOptions && insertFontFamilies) {
			  const insertedFamilies = fallbackMap.map(f => `"${f.name}"`).join(', ')
			  s.prependLeft(fallbackOptions.index, `, ${insertedFamilies}`)
			}
		  }

		function processNode(node: CssNode, parentOffset = 0) {
			walk(node, {
				visit: 'Declaration',
				enter(node) {
					console.log('this: ', this)
					if (this.atrule?.name === 'font-family' && node.property === 'font-family') {
						for (const family of extractFontFamilies(node)) {
							console.log("family: ", family);
							existingFontFamilies.add(family);
						}
					}
				}
			})

			walk(node, {
				visit: 'Declaration',
				enter(node) {
				  if (((node.property !== 'font-family' && node.property !== 'font') && (!options.processCSSVariables || !node.property.startsWith('--'))) || this.atrule?.name === 'font-face') {
					return
				  }
		
				  // Only add @font-face for the first font-family in the list and treat the rest as fallbacks
				  const [fontFamily, ...fallbacks] = extractFontFamilies(node)
				  if (fontFamily && !existingFontFamilies.has(fontFamily)) {
					promises.push(addFontFaceDeclaration(fontFamily, node.value.type !== 'Raw'
					  ? {
						  fallbacks,
						  generic: extractGeneric(node),
						  index: extractEndOfFirstChild(node)! + parentOffset,
						}
					  : undefined))
				  }
				},
			  })
		
			  // Process nested CSS until `css-tree` supports it: https://github.com/csstree/csstree/issues/268#issuecomment-2417963908
			//   walk(node, {
			// 	visit: 'Raw',
			// 	enter(node) {
			// 	  const nestedRaw = parse(node.value, { positions: true }) as StyleSheet
			// 	  const isNestedCss = nestedRaw.children.some(child => child.type === 'Rule')
			// 	  if (!isNestedCss) return
			// 	  parentOffset += node.loc!.start.offset
			// 	  processNode(nestedRaw, parentOffset)
			// 	},
			//   })
		}

		processNode(ast);

		await Promise.all(promises)

		return s;
	}


	return {
		name: "vite-plugin-fontless",

		configResolved(config) {
			console.log("LOG: fontless - configResolved");
			isDev = config.command === "serve";
			console.log('isDev: ', isDev);
			if (isDev || !config.esbuild || postcssOptions) {
			  return
			}
	
			postcssOptions = {
			  target: config.esbuild.target,
			  ...resolveMinifyCssEsbuildOptions(config.esbuild),
			}
		  },
		  renderChunk(code, chunk) {
			if (chunk.facadeModuleId) {
			  for (const file of chunk.moduleIds) {
				if (options.fontsToPreload.has(file)) {
				  options.fontsToPreload.set(chunk.facadeModuleId, options.fontsToPreload.get(file)!)
				}
			  }
			}
		  },
		  generateBundle: {
			async handler(_outputOptions, bundle) {
			  for (const key in bundle) {
				const chunk = bundle[key]!
				if (chunk?.type === 'asset' && isCSS(chunk.fileName)) {
				  const s = await transformCSS(chunk.source.toString(), key, { relative: true, })
				  if (s.hasChanged()) {
					chunk.source = s.toString()
				  }
				}
			  }
			},
		  },
	};
}

// Copied from vue-bundle-renderer utils
const IS_CSS_RE = /\.(?:css|scss|sass|postcss|pcss|less|stylus|styl)(?:\?[^.]+)?$/

function isCSS(id: string) {
  return IS_CSS_RE.test(id)
}

// Inlined from https://github.com/vitejs/vite/blob/main/packages/vite/src/node/plugins/css.ts#L1824-L1849
function resolveMinifyCssEsbuildOptions(options: ESBuildOptions): TransformOptions {
  const base: TransformOptions = {
    charset: options.charset ?? 'utf8',
    logLevel: options.logLevel,
    logLimit: options.logLimit,
    logOverride: options.logOverride,
    legalComments: options.legalComments,
  }

  if (options.minifyIdentifiers != null || options.minifySyntax != null || options.minifyWhitespace != null) {
    return {
      ...base,
      minifyIdentifiers: options.minifyIdentifiers ?? true,
      minifySyntax: options.minifySyntax ?? true,
      minifyWhitespace: options.minifyWhitespace ?? true,
    }
  }

  return { ...base, minify: true }
}
