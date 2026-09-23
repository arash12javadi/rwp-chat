/**
 * Adds the chat widgets to the page builder, if there is one.
 *
 * ./widgets.tsx imports rwp-page-builder directly, so it is reached only through the dynamic
 * import below: on a site with the chatbot and no builder, that module — and the whole builder
 * with it — is never downloaded, and the failed import is the expected outcome rather than an
 * error. The chatbot must not depend on the builder to work.
 *
 * Returns the cleanup synchronously so it can go straight into the plugin's cleanup list, even
 * though the registration itself finishes a tick later.
 */
export function registerChatWidgets(): () => void {
  let remove: (() => void) | null = null;
  let cancelled = false;

  import('./widgets')
    .then(({ registerChatWidgets: add }) => {
      if (cancelled) return;
      remove = add();
    })
    .catch(() => {
      // No page builder on this site. Nothing to register, and nothing is wrong.
    });

  return () => {
    cancelled = true;
    remove?.();
    remove = null;
  };
}
