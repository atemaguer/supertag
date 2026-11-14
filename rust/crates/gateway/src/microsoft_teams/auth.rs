use super::{Connector, bounded_json, service_url};
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde::Deserialize;
use serde_json::Value;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: String,
    crit: Option<Vec<String>>,
}
#[derive(Deserialize)]
struct Claims {
    iss: String,
    aud: Value,
    exp: i64,
    nbf: Option<i64>,
    #[serde(alias = "serviceUrl")]
    serviceurl: String,
}
#[derive(Deserialize)]
struct Jwk {
    kty: String,
    kid: String,
    n: String,
    e: String,
    alg: Option<String>,
    r#use: Option<String>,
    endorsements: Option<Vec<String>>,
}
pub(super) struct Keys {
    keys: Vec<Jwk>,
    expires: Instant,
    refresh_unknown_after: Instant,
}
pub(super) struct Token {
    pub value: String,
    pub expires: Instant,
}
pub(super) enum AuthFailure {
    Rejected,
    Unavailable,
}
fn decode(value: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| anyhow::anyhow!("invalid JWT encoding"))
}
fn parse(token: &str, app: &str, url: &str, now: i64) -> Result<(Header, Claims, Vec<u8>, String)> {
    ensure!(token.len() <= 16384, "JWT too large");
    let parts: Vec<_> = token.split('.').collect();
    ensure!(parts.len() == 3, "invalid JWT");
    let header: Header = serde_json::from_slice(&decode(parts[0])?)?;
    ensure!(
        header.alg == "RS256"
            && !header.kid.is_empty()
            && header.kid.len() <= 128
            && header.crit.as_ref().is_none_or(Vec::is_empty),
        "unsupported JWT signing identity"
    );
    let claims: Claims = serde_json::from_slice(&decode(parts[1])?)?;
    let audience = |value: &str| {
        value == app || value == format!("api://{app}") || value == format!("api://botid-{app}")
    };
    let permitted = match &claims.aud {
        Value::String(value) => audience(value),
        Value::Array(values) if values.len() <= 8 => {
            values.iter().filter_map(Value::as_str).any(audience)
        }
        _ => false,
    };
    ensure!(
        claims.iss == "https://api.botframework.com" && permitted,
        "JWT issuer or audience rejected"
    );
    ensure!(
        claims.exp > 0
            && now <= claims.exp.saturating_add(300)
            && claims
                .nbf
                .is_none_or(|nbf| nbf <= now.saturating_add(300) && nbf < claims.exp),
        "JWT validity rejected"
    );
    ensure!(
        service_url(&claims.serviceurl)? == service_url(url)?,
        "JWT service URL mismatch"
    );
    Ok((
        header,
        claims,
        decode(parts[2])?,
        format!("{}.{}", parts[0], parts[1]),
    ))
}
fn verify(key: &Jwk, message: &str, signature: &[u8]) -> Result<()> {
    ensure!(
        key.kty == "RSA"
            && key.alg.as_deref().is_none_or(|v| v == "RS256")
            && key.r#use.as_deref().is_none_or(|v| v == "sig")
            && key
                .endorsements
                .as_ref()
                .is_none_or(|v| v.iter().any(|v| v == "msteams")),
        "untrusted Microsoft Teams signing key"
    );
    let n = decode(&key.n)?;
    let e = decode(&key.e)?;
    ensure!(
        (256..=1024).contains(&n.len()) && (1..=8).contains(&e.len()),
        "invalid RSA key bounds"
    );
    RsaPublicKeyComponents { n: &n, e: &e }
        .verify(&RSA_PKCS1_2048_8192_SHA256, message.as_bytes(), signature)
        .map_err(|_| anyhow::anyhow!("invalid Microsoft Teams signature"))
}
impl Connector {
    pub(super) async fn authenticate(
        &self,
        token: &str,
        url: &str,
    ) -> std::result::Result<(), AuthFailure> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| AuthFailure::Unavailable)?
            .as_secs() as i64;
        let (header, _, signature, message) =
            parse(token, &self.config.app_id, url, now).map_err(|_| AuthFailure::Rejected)?;
        let mut cache = self.keys.lock().await;
        let refresh = cache.as_ref().is_none_or(|cache| {
            cache.expires <= Instant::now()
                || (!cache.keys.iter().any(|key| key.kid == header.kid)
                    && cache.refresh_unknown_after <= Instant::now())
        });
        if refresh {
            let unknown = cache
                .as_ref()
                .is_some_and(|cache| cache.expires > Instant::now());
            // Rate-limit refresh caused by an unknown kid, including failed HTTP refreshes.
            if let Some(cache) = cache.as_mut() {
                cache.refresh_unknown_after = Instant::now() + Duration::from_secs(30);
            }
            let mut loaded = self
                .fetch_keys()
                .await
                .map_err(|_| AuthFailure::Unavailable)?;
            if unknown {
                loaded.refresh_unknown_after = Instant::now() + Duration::from_secs(30);
            }
            *cache = Some(loaded);
        }
        let cache = cache.as_ref().ok_or(AuthFailure::Unavailable)?;
        let mut matching = cache.keys.iter().filter(|key| key.kid == header.kid);
        let key = matching.next().ok_or(AuthFailure::Rejected)?;
        if matching.next().is_some() {
            return Err(AuthFailure::Rejected);
        }
        verify(key, &message, &signature).map_err(|_| AuthFailure::Rejected)
    }
    async fn fetch_keys(&self) -> Result<Keys> {
        let response = self
            .http
            .get(self.metadata.clone())
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Microsoft key metadata unavailable"))?;
        ensure!(
            response.status().is_success(),
            "Microsoft key metadata rejected"
        );
        let metadata = bounded_json(response).await?;
        ensure!(
            metadata["issuer"] == "https://api.botframework.com"
                && metadata["id_token_signing_alg_values_supported"]
                    .as_array()
                    .is_some_and(|v| v.iter().any(|v| v == "RS256")),
            "invalid Microsoft key metadata"
        );
        let expected = self.metadata.join("keys")?;
        ensure!(
            metadata["jwks_uri"].as_str() == Some(expected.as_str()),
            "Microsoft key URL escaped trusted metadata origin"
        );
        let response = self
            .http
            .get(expected)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Microsoft signing keys unavailable"))?;
        ensure!(
            response.status().is_success(),
            "Microsoft signing keys rejected"
        );
        let body = bounded_json(response).await?;
        let keys: Vec<Jwk> = serde_json::from_value(body["keys"].clone())?;
        ensure!(
            !keys.is_empty() && keys.len() <= 64,
            "invalid Microsoft key count"
        );
        Ok(Keys {
            keys,
            expires: Instant::now() + Duration::from_secs(12 * 3600),
            refresh_unknown_after: Instant::now(),
        })
    }
    pub(super) async fn access_token(&self) -> Result<String> {
        let mut cache = self.token.lock().await;
        if let Some(token) = cache.as_ref()
            && token.expires > Instant::now()
        {
            return Ok(token.value.clone());
        }
        let response = self
            .http
            .post(self.token_url.clone())
            .form(&[
                ("client_id", self.config.app_id.as_str()),
                ("client_secret", self.config.app_secret.as_str()),
                ("grant_type", "client_credentials"),
                ("scope", "https://api.botframework.com/.default"),
            ])
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Microsoft token exchange unavailable"))?;
        ensure!(
            response.status().is_success(),
            "Microsoft token exchange rejected"
        );
        let value = bounded_json(response).await?;
        let token = value["access_token"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 16384 && !v.chars().any(char::is_control))
            .context("Microsoft access token missing")?;
        ensure!(
            value["token_type"]
                .as_str()
                .is_some_and(|v| v.eq_ignore_ascii_case("Bearer")),
            "invalid Microsoft token type"
        );
        let expiry = value["expires_in"]
            .as_u64()
            .filter(|v| *v > 5 && *v <= 86400)
            .context("invalid Microsoft token expiry")?;
        *cache = Some(Token {
            value: token.into(),
            expires: Instant::now() + Duration::from_secs(expiry - expiry.min(120) / 2),
        });
        Ok(token.into())
    }
}
#[cfg(test)]
mod tests {
    use super::super::fixtures;
    use super::*;
    use serde_json::json;
    fn claims() -> Value {
        json!({"iss":"https://api.botframework.com","aud":"fixture-app","exp":2000,"nbf":900,"serviceurl":"https://smba.trafficmanager.net/amer/"})
    }
    #[test]
    fn real_rsa_signature_and_required_claims() {
        let jwt = fixtures::token(claims(), "fixture");
        let (header, _, signature, input) = parse(
            &jwt,
            "fixture-app",
            "https://smba.trafficmanager.net/amer",
            1000,
        )
        .unwrap();
        assert_eq!(header.kid, "fixture");
        let key: Jwk =
            serde_json::from_value(fixtures::jwks("fixture")["keys"][0].clone()).unwrap();
        verify(&key, &input, &signature).unwrap();
        assert!(verify(&key, &format!("{input}x"), &signature).is_err());
        for (field, value) in [
            ("iss", json!("wrong")),
            ("aud", json!("wrong")),
            ("exp", json!(600)),
            ("nbf", json!(1500)),
            ("serviceurl", json!("https://elsewhere.example/")),
        ] {
            let mut c = claims();
            c[field] = value;
            assert!(
                parse(
                    &fixtures::token(c, "fixture"),
                    "fixture-app",
                    "https://smba.trafficmanager.net/amer",
                    1000
                )
                .is_err(),
                "{field}"
            );
        }
        let mut c = claims();
        c.as_object_mut().unwrap().remove("exp");
        assert!(
            parse(
                &fixtures::token(c, "fixture"),
                "fixture-app",
                "https://smba.trafficmanager.net/amer",
                1000
            )
            .is_err()
        );
    }
    #[test]
    fn rejects_algorithm_substitution_and_unknown_critical_headers() {
        let jwt = fixtures::token(claims(), "fixture");
        let suffix = jwt.split_once('.').unwrap().1;
        for header in [
            json!({"alg":"HS256","kid":"fixture"}),
            json!({"alg":"none","kid":"fixture"}),
            json!({"alg":"RS256","kid":"fixture","crit":["unsupported"]}),
        ] {
            let modified = format!("{}.{}", URL_SAFE_NO_PAD.encode(header.to_string()), suffix);
            assert!(
                parse(
                    &modified,
                    "fixture-app",
                    "https://smba.trafficmanager.net/amer",
                    1000
                )
                .is_err()
            );
        }
    }
    #[test]
    fn channel_endorsement_and_duplicate_claim_alias_fail_closed() {
        let mut c = claims();
        c["serviceUrl"] = c["serviceurl"].clone();
        assert!(
            parse(
                &fixtures::token(c, "fixture"),
                "fixture-app",
                "https://smba.trafficmanager.net/amer",
                1000
            )
            .is_err()
        );
        let mut value = fixtures::jwks("fixture");
        value["keys"][0]["endorsements"] = json!(["slack"]);
        let key: Jwk = serde_json::from_value(value["keys"][0].clone()).unwrap();
        let jwt = fixtures::token(claims(), "fixture");
        let (_, _, signature, input) = parse(
            &jwt,
            "fixture-app",
            "https://smba.trafficmanager.net/amer",
            1000,
        )
        .unwrap();
        assert!(verify(&key, &input, &signature).is_err());
    }
}
