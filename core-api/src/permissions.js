const RANK = { editor: 1, approver: 2, owner: 3 }

const MIN_ROLE = {
  ver_perfil: 'editor',
  capturar: 'editor',
  editar_boceto: 'editor',
  aprobar: 'approver',
  programar: 'approver',
  editar_perfil: 'owner',
  gestionar_canales: 'owner',
  invitar: 'owner',
}

export function roleFor(db, userId, profileId) {
  const row = db.prepare(
    'SELECT role FROM user_profile_access WHERE user_id = ? AND profile_id = ?'
  ).get(userId, profileId)
  return row ? row.role : null
}

export function can(db, userId, profileId, action) {
  const min = MIN_ROLE[action]
  if (!min) throw new Error(`acción desconocida: ${action}`)
  const role = roleFor(db, userId, profileId)
  return role !== null && RANK[role] >= RANK[min]
}
