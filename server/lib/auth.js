/**
 * auth.js — the admin-key gate, in one place.
 *
 * Previously implemented twice, in admin.js and documents.js, which is how
 * /build ended up unprotected: uploading a single document required the key
 * while ingesting a whole directory did not, though both spend the same money
 * and write the same store.
 *
 * Gate anything that spends, writes, or destroys. Reading is open — this is a
 * knowledge base, and the point of it is being read.
 *
 * With ADMIN_KEY unset the gate is open, which is right for a local
 * single-operator run and wrong for anything reachable. The server says so at
 * boot rather than leaving it to be discovered.
 */

export function requireAdmin(req, res, next) {
  const configured = process.env.ADMIN_KEY;
  if (!configured) return next();          // unset = open, deliberately

  const supplied = req.headers['x-admin-key'] || req.query.key;
  if (supplied !== configured) {
    return res.status(401).json({
      error: 'Unauthorized — this action needs the admin key (x-admin-key header).',
    });
  }
  next();
}

/** True when the server is running without an admin key set. */
export function isOpen() {
  return !process.env.ADMIN_KEY;
}
