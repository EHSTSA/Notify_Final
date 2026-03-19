import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDWqSi2Is6YLcwKPf-A2A5ekbk2QEd52MQ",
  authDomain: "tsa-sound-detector.firebaseapp.com",
  projectId: "tsa-sound-detector",
  storageBucket: "tsa-sound-detector.firebasestorage.app",
  messagingSenderId: "895425942202",
  appId: "1:895425942202:web:727262b3c1d2e20e6b2883",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
  useFetchStreams: false,
});

export { app, auth, db };
