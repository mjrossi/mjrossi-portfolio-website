// Submit handler for the newsletter form on /blog. Served as a static asset
// via Cloudflare's ASSETS binding so it loads as an external module under a
// strict `script-src 'self' https://challenges.cloudflare.com` CSP — no
// 'unsafe-inline' needed.
//
// Plain JS (not TS): Astro's bundler routes .ts <script> contents through
// Vite, which can inline the result rather than emit an external chunk for
// on-demand routes. Shipping the file as a static asset under public/ avoids
// that uncertainty — what we write is what gets served.
//
// This file is the only client JavaScript on the site. Do not import it
// outside src/components/NewsletterSignup.astro (which is only rendered on
// /blog). Smoke asserts the form is present on /blog and absent on / as a
// regression guard against accidental lifts into shared chrome.

(() => {
  const form = document.getElementById('newsletter-form');
  if (!form) return;

  const msg = form.querySelector('.newsletter-msg');
  const btn = form.querySelector('button[type=submit]');
  const emailInput = form.querySelector('input[name=email]');
  const hpInput = form.querySelector('input[name=company]');

  const turnstile = () => window.turnstile;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    const company = hpInput.value;
    const turnstileToken = turnstile()?.getResponse?.() ?? '';

    msg.classList.remove('is-error');
    msg.textContent = '';

    if (!email) {
      msg.textContent = 'Please enter your email.';
      msg.classList.add('is-error');
      return;
    }
    if (!turnstileToken) {
      msg.textContent = 'Please complete the spam check.';
      msg.classList.add('is-error');
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
        form.replaceWith(success);
        return;
      }
      const data = await res.json().catch(() => ({}));
      msg.textContent =
        data.error === 'invalid_email'
          ? 'That email address looks off.'
          : data.error === 'turnstile_failed'
            ? 'Spam check failed. Try again.'
            : 'Something went wrong. Try again in a minute.';
      msg.classList.add('is-error');
      turnstile()?.reset?.();
      btn.disabled = false;
    } catch {
      msg.textContent = 'Network error. Please try again.';
      msg.classList.add('is-error');
      turnstile()?.reset?.();
      btn.disabled = false;
    }
  });
})();
