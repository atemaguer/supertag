use std::net::{Ipv4Addr, Ipv6Addr};

use supertag_protocol::v2::NetworkRule;

use super::*;

const HOST: &str = "api.example.test";
const SECRET: &str = "ghp_real_secret_value";

async fn origin_server() -> (SocketAddr, CertificateDer<'static>) {
    fixture::origin_server(HOST).await
}

fn origin_of(address: SocketAddr) -> String {
    format!("https://{HOST}:{}", address.port())
}

fn rule(origins: &[String], methods: &[&str], credential: &str) -> NetworkRule {
    NetworkRule {
        origins: origins.to_vec(),
        methods: methods.iter().map(|method| (*method).to_owned()).collect(),
        credential: credential.to_owned(),
    }
}

async fn proxy(
    address: SocketAddr,
    root: CertificateDer<'static>,
    allow_private: bool,
) -> EgressProxy {
    let origin = origin_of(address);
    let scope = NetworkScope {
        any_origin: false,
        rules: vec![
            rule(&[origin.clone()], &["GET", "POST"], ""),
            rule(&[origin], &["GET"], "github"),
        ],
    };
    let mut config = Config::new(
        scope,
        vec![Credential::new("github", "GITHUB_TOKEN", SECRET.to_owned())],
    );
    config.resolve.insert(HOST.to_owned(), address);
    config.allow_private = allow_private;
    config.extra_roots.push(root);
    EgressProxy::start(config).await.unwrap()
}

fn client(proxy: &EgressProxy, with_password: bool) -> reqwest::Client {
    let url = if with_password {
        proxy.url()
    } else {
        format!("http://{}", proxy.address())
    };
    reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(url).unwrap())
        .add_root_certificate(reqwest::Certificate::from_pem(proxy.ca_pem().as_bytes()).unwrap())
        .build()
        .unwrap()
}

#[tokio::test]
async fn injects_a_bound_credential_and_logs_each_decision() {
    let (address, root) = origin_server().await;
    let proxy = proxy(address, root, true).await;
    let placeholder = proxy.credentials()[0].placeholder.clone();
    assert!(placeholder.starts_with("supertag-credential-github-"));
    let client = client(&proxy, true);
    let base = origin_of(address);

    // Bearer: the origin receives the secret; the client only ever held the placeholder.
    let body = client
        .get(format!("{base}/repos/{placeholder}?token=abc"))
        .bearer_auth(&placeholder)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(body, format!("GET /repos/{placeholder} Bearer {SECRET}"));

    // Basic, as git sends it.
    let body = client
        .get(format!("{base}/info/refs"))
        .basic_auth("x-access-token", Some(&placeholder))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let expected =
        base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{SECRET}"));
    assert_eq!(body, format!("GET /info/refs Basic {expected}"));

    // POST is allowed without the credential, but the credential is bound to GET only.
    let response = client.post(format!("{base}/x")).send().await.unwrap();
    assert_eq!(response.text().await.unwrap(), "POST /x ");
    let response = client
        .post(format!("{base}/x"))
        .bearer_auth(&placeholder)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    assert!(
        response
            .text()
            .await
            .unwrap()
            .contains("credential github is not allowed")
    );

    // A method no rule allows.
    let response = client.delete(format!("{base}/x")).send().await.unwrap();
    assert_eq!(response.status(), 403);

    // An origin outside the scope is refused before any TLS.
    let error = client
        .get(format!("https://other.example.test:{}/", address.port()))
        .send()
        .await
        .unwrap_err();
    assert!(error.is_connect() || error.is_request(), "{error}");

    // Plain HTTP is refused.
    let response = client
        .get(format!("http://{HOST}:{}/", address.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);

    let log = proxy.stop().await;
    assert_eq!((log.allowed, log.denied), (3, 4), "{log:?}");
    let first = &log.requests[0];
    assert!(first.allowed);
    assert_eq!(first.method, "GET");
    assert_eq!(first.origin, base);
    // No query, and neither the secret nor the placeholder.
    assert_eq!(first.path, "/repos/[credential]");
    assert_eq!(first.credential, "github");
    assert_eq!(first.status, 200);
    let reasons: Vec<&str> = log
        .requests
        .iter()
        .filter(|record| !record.allowed)
        .map(|record| record.reason.as_str())
        .collect();
    assert_eq!(
        reasons,
        [
            "credential github is not allowed for this origin and method",
            "the method is not allowed for this origin",
            "origin is not in the Task's network scope",
            "only https:// origins are allowed",
        ],
        "{log:?}"
    );
    let serialized = format!("{log:?}");
    assert!(!serialized.contains(SECRET));
    assert!(!serialized.contains(&placeholder));
}

#[tokio::test]
async fn refuses_clients_without_the_password_and_non_public_destinations() {
    let (address, root) = origin_server().await;
    let proxy = proxy(address, root, false).await;
    let base = origin_of(address);
    let error = client(&proxy, false)
        .get(format!("{base}/"))
        .send()
        .await
        .unwrap_err();
    assert!(error.is_connect() || error.is_request(), "{error}");
    // Nothing is logged for a client that is not this Attempt's.
    assert_eq!(proxy.log().denied, 0);
    // The scope allows the origin, but it resolves to loopback.
    let error = client(&proxy, true)
        .get(format!("{base}/"))
        .send()
        .await
        .unwrap_err();
    assert!(error.is_connect() || error.is_request(), "{error}");
    let log = proxy.stop().await;
    assert_eq!(log.denied, 1);
    assert_eq!(
        log.requests[0].reason,
        "the host resolves to a loopback, private, or reserved address"
    );
}

#[tokio::test]
async fn keeps_the_first_requests_and_counts_the_rest() {
    let (address, root) = origin_server().await;
    let proxy = proxy(address, root, true).await;
    for _ in 0..(MAX_LOGGED_REQUESTS + 3) {
        proxy
            .state
            .record("GET", "https://a.example.com", "/", Err("x"));
    }
    let log = proxy.stop().await;
    assert_eq!(log.requests.len(), MAX_LOGGED_REQUESTS);
    assert_eq!(
        (log.denied, log.unrecorded),
        (MAX_LOGGED_REQUESTS as u64 + 3, 3)
    );
}

#[test]
fn public_addresses_exclude_local_private_and_reserved_ranges() {
    for address in [
        IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
        IpAddr::V4(Ipv4Addr::new(10, 1, 2, 3)),
        IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1)),
        IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1)),
        IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)),
        IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)),
        IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0)),
        IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1)),
        IpAddr::V4(Ipv4Addr::new(255, 255, 255, 255)),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
        IpAddr::V6("fd00::1".parse().unwrap()),
        IpAddr::V6("fe80::1".parse().unwrap()),
        IpAddr::V6("::ffff:10.0.0.1".parse().unwrap()),
    ] {
        assert!(!public(address), "{address}");
    }
    for address in [
        IpAddr::V4(Ipv4Addr::new(140, 82, 112, 6)),
        IpAddr::V4(Ipv4Addr::new(151, 101, 0, 223)),
        IpAddr::V6("2606:4700::6810:84e5".parse().unwrap()),
    ] {
        assert!(public(address), "{address}");
    }
}
