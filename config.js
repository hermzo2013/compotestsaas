// Configuration publique du navigateur. La clé anon/publishable Supabase est conçue pour être publique.
// La sécurité repose sur les politiques RLS du fichier supabase_schema.sql.
// NE JAMAIS mettre ici une clé service_role, une clé Groq ou une autre clé secrète.
window.COMPOSTEST_CONFIG = {
  SUPABASE_URL: 'https://VOTRE-PROJET.supabase.co',
  SUPABASE_ANON_KEY: 'votre_cle_anon_ou_publishable'
};
