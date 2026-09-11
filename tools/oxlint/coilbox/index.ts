import { eslintCompatPlugin } from "@oxlint/plugins";

import { noAdditionalRendererRule } from "./rules/no-additional-renderer.ts";
import { noClassnameAfterSpreadRule } from "./rules/no-classname-after-spread.ts";
import { noDirectVendorImportRule } from "./rules/no-direct-vendor-import.ts";
import { noRuntimeImportsEditorRule } from "./rules/no-runtime-imports-editor.ts";
import { noStylexOutsideEditorRule } from "./rules/no-stylex-outside-editor.ts";

/**
 * Coilbox's own architectural rules.
 *
 * Each rule mechanizes a rule that `AGENTS.md` already states in prose but that nothing checked:
 * the single vendor boundary, the single-runtime renderer budget, the runtime-to-editor layering
 * direction, the editor-only styling toolchain, and the one StyleX mistake that fails invisibly. They exist because the documented invariants
 * were true when written and would otherwise stay true only by luck.
 */
const coilboxPlugin = eslintCompatPlugin({
  meta: { name: "coilbox" },
  rules: {
    "no-additional-renderer": noAdditionalRendererRule,
    "no-classname-after-spread": noClassnameAfterSpreadRule,
    "no-direct-vendor-import": noDirectVendorImportRule,
    "no-runtime-imports-editor": noRuntimeImportsEditorRule,
    "no-stylex-outside-editor": noStylexOutsideEditorRule,
  },
});

export default coilboxPlugin;
