import type { ModuleLoaderResolveId } from '../ModuleLoader';
import type { CustomPluginOptions, Plugin, PluginContext, ResolveIdResult } from '../rollup/types';
import type { PluginDriver, ReplaceContext } from './PluginDriver';
import { BLANK, EMPTY_OBJECT } from './blank';

export function resolveIdViaPlugins(
	source: string,
	importer: string | undefined,
	pluginDriver: PluginDriver,
	moduleLoaderResolveId: ModuleLoaderResolveId,
	skip: readonly { importer: string | undefined; plugin: Plugin; source: string }[] | null,
	customOptions: CustomPluginOptions | undefined,
	isEntry: boolean,
	attributes: Record<string, string>
): Promise<[NonNullable<ResolveIdResult>, Plugin] | null> {
	let skipped: Set<Plugin> | null = null;
	let replaceContext: ReplaceContext | null = null;
	if (skip) {
		skipped = new Set();
		for (const skippedCall of skip) {
			if (source === skippedCall.source && importer === skippedCall.importer) {
				skipped.add(skippedCall.plugin);
			}
		}
		replaceContext = (pluginContext, plugin): PluginContext => ({
			...pluginContext,
			resolve: (source, importer, { attributes, custom, isEntry, skipSelf } = BLANK) => {
				skipSelf ??= true;
				return moduleLoaderResolveId(
					source,
					importer,
					custom,
					isEntry,
					attributes || EMPTY_OBJECT,
					skipSelf ? [...skip, { importer, plugin, source }] : skip
				);
			}
		});
	}

	/**
	 * @description 第一次调用解析入口文件
	 * @returns [ResolveIdResult, Plugin]
	 * @fires 🧲[resolveId]
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-01 15:02
	 */
	const resolveIdResultAndPlugin = pluginDriver.hookFirstAndGetPlugin(
		'resolveId',
		[source, importer, { attributes, custom: customOptions, isEntry }],
		replaceContext,
		skipped
	);
	return resolveIdResultAndPlugin;
}
