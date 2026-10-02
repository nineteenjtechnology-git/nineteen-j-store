// Nineteen J Store - helpers Auth Firebase (panneau admin)
// Volontairement Google uniquement (voir audit sécurité M5) : un point d'accès
// unique, protégé par la validation en 2 étapes du compte Google, plutôt qu'un
// mot de passe propre au site. Pense à désactiver le provider "Email/Password"
// dans Firebase Console > Authentication > Sign-in method (geste manuel, hors code).
import { auth, googleProvider, onAuthStateChanged, signInWithPopup, signOut } from './firebase-config.js';

export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function loginWithGoogle() {
  const cred = await signInWithPopup(auth, googleProvider);
  return cred.user;
}

export async function logout() {
  await signOut(auth);
}
