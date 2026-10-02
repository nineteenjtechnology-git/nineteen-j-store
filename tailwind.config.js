/** Tailwind compilé en local (plus de CDN Play, qui exécute un compilateur JS dans le navigateur). */
module.exports = {
  content: ['./public/**/*.html', './public/js/**/*.js', '!./public/js/vendor/**'],
  theme: { extend: {} },
  plugins: []
};
