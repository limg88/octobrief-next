-- Sources fed from a synchronized folder: the worker reads the files a synchronization keeps on
-- this machine instead of the system itself. The kind of the source stays the system's own
-- (jira, ado, m365, dwsi, files), so what depends on it does not change.
ALTER TABLE sources
  ADD COLUMN folder_path text CHECK (folder_path IS NULL OR folder_path ~ '^/'),
  -- One way in for each source: a folder, a token, or a credential.
  ADD CONSTRAINT sources_one_feed CHECK (
    (folder_path IS NULL OR (token_hash IS NULL AND secret_ciphertext IS NULL))
    AND (token_hash IS NULL OR secret_ciphertext IS NULL)
  );
