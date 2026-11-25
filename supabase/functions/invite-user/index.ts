// Supabase Edge Function: invite-user
// Lets an admin create a sign-in link from Setup → Users without opening the Supabase dashboard.
// The service key only ever lives here, on Supabase's servers (it is provided to every Edge
// Function automatically); the app never sees it.
//
// POST { email, name?, role?, can_apply?, redirect_to? }
//   New email  → creates the login and returns a one-time "invite" link (no email is sent).
//   Known email → returns a one-time "set a new password" link; their role is left alone
//   (change roles in the Users list, where the last-admin guard applies).
// Returns { link, existing }. The admin texts or copies the link to the person.
//
// Deploy: Supabase dashboard → Edge Functions → Deploy a new function → Via editor,
// name it invite-user, paste this file, Deploy. Leave "Verify JWT" on.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const ROLES = ['admin', 'manager', 'employee', 'none'];
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  // Who is asking? Must be a signed-in admin.
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: caller } = await admin.auth.getUser(jwt);
  if (!caller?.user) return reply(401, { error: 'Sign in first' });
  const { data: me } = await admin.from('profiles').select('role').eq('user_id', caller.user.id).maybeSingle();
  if (me?.role !== 'admin') return reply(403, { error: 'Only an admin can invite people' });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply(400, { error: 'Bad request' }); }
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply(400, { error: 'That email doesn’t look right' });
  const role = body.role == null ? null : String(body.role);
  if (role != null && !ROLES.includes(role)) return reply(400, { error: 'Unknown role' });
  const redirectTo = typeof body.redirect_to === 'string' ? body.redirect_to : undefined;

  // New person → invite link. Already has a login → password-reset link instead.
  let existing = false;
  let res = await admin.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo } });
  if (res.error && /already|registered|exists/i.test(res.error.message)) {
    existing = true;
    res = await admin.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
  }
  if (res.error || !res.data?.user) return reply(400, { error: res.error?.message ?? 'Couldn’t create the link' });

  // New logins only: the new-user trigger already made a profile row with no access; fill in what the admin picked.
  const patch: Record<string, unknown> = {};
  if (role != null) patch.role = role;
  if (typeof body.can_apply === 'boolean') patch.can_apply = body.can_apply;
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (!existing && Object.keys(patch).length) {
    const { error } = await admin.from('profiles').update(patch).eq('user_id', res.data.user.id);
    if (error) return reply(400, { error: `Login made, but the role didn’t save: ${error.message}` });
  }
  return reply(200, { link: res.data.properties.action_link, existing });
});
