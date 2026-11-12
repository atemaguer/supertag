//! Public synthetic credentials for local provider-shaped fixtures only.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
    rand::SystemRandom,
    signature::{RSA_PKCS1_SHA256, RsaKeyPair},
};
use rustls_pki_types::{PrivateKeyDer, pem::PemObject as _};
use serde_json::{Value, json};
pub fn token(claims: Value, kid: &str) -> String {
    let pem = include_bytes!("../github/auth/fixtures/app-test-key.pem");
    let key = match PrivateKeyDer::from_pem_slice(pem).unwrap() {
        PrivateKeyDer::Pkcs8(key) => RsaKeyPair::from_pkcs8(key.secret_pkcs8_der()).unwrap(),
        PrivateKeyDer::Pkcs1(key) => RsaKeyPair::from_der(key.secret_pkcs1_der()).unwrap(),
        _ => panic!("fixture RSA key"),
    };
    let header = URL_SAFE_NO_PAD.encode(json!({"alg":"RS256","typ":"JWT","kid":kid}).to_string());
    let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
    let input = format!("{header}.{payload}");
    let mut signature = vec![0; key.public().modulus_len()];
    key.sign(
        &RSA_PKCS1_SHA256,
        &SystemRandom::new(),
        input.as_bytes(),
        &mut signature,
    )
    .unwrap();
    format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature))
}
pub fn jwks(kid: &str) -> Value {
    let mut value: Value = serde_json::from_str(include_str!("fixture-jwks.json")).unwrap();
    value["keys"][0]["kid"] = kid.into();
    value
}
