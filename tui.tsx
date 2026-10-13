import { Plugin } from "@opencode/plugin/tui";
import type { PluginContext } from "@opencode/plugin/tui";
import { strategyBadge } from "./strategy-badge";

/**
 * The `cow` sidebar badge.
 *
 * opencode2's TUI runtime loads this module and provides `@opencode/plugin/tui`
 * and `solid-js` by specifier rewrite — they are not installable dependencies.
 *
 * The value is resolved BEFORE the slot is registered, so the render is a plain
 * constant read. A slot claim is rendered through opencode2's `provide()`,
 * which calls the render function once, untracked and outside any reactive
 * owner: a signal or `<Show>` read inside that render is captured at its
 * initial value and never updates. Resolving first and registering after avoids
 * reactivity in the render entirely.
 *
 * The trade-off: the badge reflects the location at load time. A session that
 * moves between the project root and a worktree mid-session will not re-resolve
 * until the plugin reloads. That is the price of a render that cannot update,
 * and it is the correct call for a decoration that must never break the footer.
 */
export default Plugin.define({
  id: "opencode-cow-worktree-tui",
  async setup(context) {
    const isCow = await resolveIsCow(context).catch(() => false);
    context.ui.slot({
      append: "sidebar.footer",
      render: () => (isCow ? <Badge context={context} /> : null),
    });
  },
});

async function resolveIsCow(context: PluginContext): Promise<boolean> {
  const directory = context.location?.directory;
  if (!directory) return false;
  const entries = await context.client.worktree.list({ location: { directory } });
  return (await strategyBadge(entries, directory)) === "cow";
}

function Badge(props: { readonly context: PluginContext }) {
  return (
    <box flexShrink={0}>
      <text fg={props.context.theme.text.subdued}> cow</text>
    </box>
  );
}
