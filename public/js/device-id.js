// Nineteen J Store - identifiant anonyme persistant par appareil/navigateur
// Sert uniquement à limiter une note par appareil sur une app (pas un compte utilisateur).
const KEY = 'njs-device-id';

export function getDeviceId() {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}
