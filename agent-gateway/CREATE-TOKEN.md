# Creating an agent token (production step, not run automatically)

Agent tokens are not the Swipe Ardy editor password. Create one token per
client, keep the plaintext only in that client's local secret manager, and
store only its SHA-256 hash in `swipeardy_agent_api_keys`.

Generate a token locally in PowerShell without putting it in a file:

```powershell
$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = 'swa_' + ([Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_'))
$hash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($token))).ToLowerInvariant()
Write-Host "Token (copy once to the client secret store): $token"
Write-Host "Hash (insert into Supabase): $hash"
```

After the migrations are approved/applied, insert the hash through the
authenticated Supabase SQL editor or another private admin channel:

```sql
insert into public.swipeardy_agent_api_keys (name, key_hash, scopes)
values ('codex', '<64-char-lowercase-sha256>', array['read','write','filters']);
```

Use a separate row/name for Hermes. To revoke a client, set `active = false`
and create a replacement token. Never place a plaintext token, service-role key,
or editor password in this repository.
