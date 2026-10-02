// Nineteen J Store - config Firebase
// Ces valeurs viennent de la Console Firebase > Paramètres du projet > Vos applications > Config SDK.
// Elles ne sont PAS secrètes (c'est la config publique d'un client web Firebase) mais restent
// spécifiques à ton projet : remplace les valeurs "TODO_" ci-dessous après `firebase init`.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';

export const firebaseConfig = {
  apiKey: "AIzaSyCM58XGGZwv2KvLXcSOWfID4vGl9WSjp_I",
  authDomain: "nineteen-j-store.firebaseapp.com",
  databaseURL: "https://nineteen-j-store-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "nineteen-j-store",
  storageBucket: "nineteen-j-store.firebasestorage.app",
  messagingSenderId: "306334013818",
  appId: "1:306334013818:web:7ce722a568cdcfb9b69ec3"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const googleProvider = new GoogleAuthProvider();

export { onAuthStateChanged, signInWithPopup, signOut };
