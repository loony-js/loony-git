export function initEnvs() {
  process.env.GIT_AUTHOR_NAME = "Sankar Boro";
  process.env.GIT_AUTHOR_EMAIL = "sankar.boro@yahoo.com";
  process.env.GIT_HTTP_USER = "sankar-boro";
  process.env.GIT_HTTP_PASSWORD = "San#Git#26";
  process.env.GIT_COMMITTER_NAME = "Sankar Boro";
  process.env.GIT_COMMITTER_EMAIL = "sankar.boro@yahoo.com";
  process.env.GIT_SSL_CAINFO = `${process.env.HOME}/snap/code/232/.local/share/mkcert/rootCA.pem`;
}
