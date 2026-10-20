// Submit handler for the newsletter form. A static asset, not bundled, so it
// loads as an external script under `script-src 'self'` exactly as written.
// Only Subscribe.astro may load it (/blog and published posts); smoke asserts
// it stays off `/`.
//
// THE STATUS LINE AND THE WIDGET ARE SIBLINGS OF THE FORM, not children, so
// `form.replaceWith` on success keeps the status line. Resolve them from the
// <aside>: from the form they are null, and the throw after preventDefault
// leaves a form that silently does nothing. Smoke guards the selector.

(() => {
  const form = document.getElementById('newsletter-form');
  if (!form) return;

  const root = form.closest('aside') ?? document;
  // A detached fallback, not a bail-out: bailing leaves a NATIVE submit, a GET
  // that puts the address in history and access logs.
  const msg = root.querySelector('.newsletter-msg') ?? document.createElement('p');
  const btn = form.querySelector('button[type=submit]');
  const emailInput = form.querySelector('input[name=email]');
  const hpInput = form.querySelector('input[name=company]');

  // Text and nodes, so the fallback can carry a link; never parsed as HTML.
  function showError(...parts) {
    msg.replaceChildren(...parts);
    msg.classList.add('is-error');
    window.turnstile?.reset?.();
    btn.disabled = false;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    const company = hpInput.value;
    const turnstileToken = window.turnstile?.getResponse?.() ?? '';

    msg.classList.remove('is-error');
    msg.textContent = '';

    if (!email) {
      showError('Please enter your email.');
      return;
    }
    if (!turnstileToken) {
      showError('Please complete the spam check.');
      return;
    }

    btn.disabled = true;
    msg.textContent = 'Subscribing…';

    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, turnstileToken, company }),
      });
      if (res.ok) {
        const success = document.createElement('p');
        success.className = 'newsletter-success';
        success.textContent = 'Check your inbox to confirm your subscription.';
        // Clear the siblings, or a leftover checkbox reads as an unfinished signup.
        root.querySelector('.cf-turnstile')?.replaceChildren();
        msg.classList.remove('is-error');
        msg.textContent = '';
        form.replaceWith(success);
        return;
      }
      const data = await res.json().catch(() => ({}));
      // (A) user-fixable, (B) transient, and everything else — misconfig or
      // probes — as one fallback linking /api/contact (the address is in no
      // static file). The server still logs each code distinctly.
      const contact = document.createElement('a');
      contact.href = '/api/contact';
      contact.textContent = 'contact me';
      const fallback = ["Something's off on our end. Please ", contact, " and I'll add you manually."];
      const messages = {
        // (A) user-fixable
        invalid_email: 'That email address looks off.',
        missing_turnstile_token: 'Please complete the spam check.',
        turnstile_failed: 'Spam check failed. Try again.',
        // (B) transient infra — naming where the flake is helps the retry decision
        rate_limited: 'Subscription temporarily rate-limited. Try again in a few minutes.',
        upstream: 'Our email provider returned an error. Try again shortly.',
        upstream_unreachable:
          "Couldn't reach our email provider. Check your connection and try again.",
        turnstile_unreachable: "Couldn't reach the spam-check service. Try again shortly.",
      };
      showError(...(Object.hasOwn(messages, data.error) ? [messages[data.error]] : fallback));
    } catch {
      showError('Network error. Please try again.');
    }
  });
})();
