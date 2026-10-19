import type { APIRoute } from 'astro';
import { securityHeaders } from '../../lib/server';
import { CARD_VCF } from '../../lib/vcard.js';

// The "Add to contacts" link on /card. An endpoint rather than a file in
// public/ for the reason /api/contact is one: the .vcf carries the address,
// and nothing static may.
//
// `inline` rather than `attachment`: iOS Safari and Messages answer an inline
// text/vcard with the system "Add to Contacts" sheet, where an attachment is
// a download the reader then has to find. Android Chrome downloads it either
// way and opens it from the notification.
//
// Cache-Control stays `no-store` from securityHeaders — unlike /blog/rss.xml,
// which sets an hour. This is /api/* and keeps that convention, the body
// carries the address, and an edge copy of a ~20 KB response saves nothing
// worth the exception.

export const GET: APIRoute = () =>
  new Response(CARD_VCF, {
    status: 200,
    headers: {
      ...securityHeaders,
      'Content-Type': 'text/vcard; charset=utf-8',
      'Content-Disposition': 'inline; filename="matthew-rossi.vcf"',
    },
  });
