use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::Path,
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use supertag_transport::Target;

use super::{
    GatewayState, Result, Session, Tag, bearer, device_name, endpoint,
    local::{self, LOCAL, LocalGateway},
};

const STORE_ERROR: &str = "Could not read or save your Gateway connections.";
const MAX_STORE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ORIGIN_BYTES: usize = 2048;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayProfile {
    name: String,
    origin: String,
}

#[derive(Deserialize, Serialize)]
struct SavedGateway {
    profile: GatewayProfile,
    token: String,
}

#[derive(Default, Deserialize, Serialize)]
struct Profiles {
    active: Option<String>,
    gateways: Vec<SavedGateway>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayList {
    profiles: Vec<GatewayProfile>,
    active: Option<String>,
    /// The local Gateway, which is found rather than saved.
    local: LocalGateway,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayActivation {
    gateways: GatewayList,
    /// The saved origin connected to, or `local` for the local Gateway.
    origin: String,
    connection_id: String,
    tags: Vec<Tag>,
    /// Whom the saved credential acts as, such as `operator:local` or `client:alice-laptop`.
    principal: String,
}

#[cfg(test)]
impl GatewayActivation {
    pub(super) fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub(super) fn principal(&self) -> &str {
        &self.principal
    }
}

impl GatewayState {
    fn list(&self, value: Profiles) -> GatewayList {
        GatewayList {
            active: value.active,
            profiles: value
                .gateways
                .into_iter()
                .map(|entry| entry.profile)
                .collect(),
            local: local::status(self.2.as_deref()),
        }
    }
}

fn open_profiles(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    validate_profile_file(&file)?;
    Ok(file)
}

fn validate_profile_file(file: &File) -> io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid takes no arguments.
        if metadata.nlink() != 1
            || metadata.mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    Ok(())
}

fn lock_profiles(path: &Path) -> Result<File> {
    let parent = path.parent().ok_or(STORE_ERROR)?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
        builder.mode(0o700);
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        builder.create(parent).map_err(|_| STORE_ERROR)?;
        let metadata = fs::symlink_metadata(parent).map_err(|_| STORE_ERROR)?;
        // SAFETY: geteuid takes no arguments.
        if !metadata.is_dir()
            || metadata.mode() & 0o022 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(STORE_ERROR.into());
        }
    }
    #[cfg(not(unix))]
    builder.create(parent).map_err(|_| STORE_ERROR)?;
    let lock_path = path.with_extension("lock");
    let file = options.open(&lock_path).map_err(|_| STORE_ERROR)?;
    validate_profile_file(&file).map_err(|_| STORE_ERROR)?;
    file.try_lock()
        .map_err(|_| "Another SuperTag window is updating the saved Gateways. Try again.")?;
    Ok(file)
}

impl Profiles {
    fn load(path: &Path) -> Result<Self> {
        let file = match open_profiles(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(_) => return Err(STORE_ERROR.into()),
        };
        let mut bytes = Vec::new();
        file.take(MAX_STORE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| STORE_ERROR)?;
        if bytes.len() as u64 > MAX_STORE_BYTES {
            return Err(STORE_ERROR.into());
        }
        serde_json::from_slice(&bytes).map_err(|_| STORE_ERROR.into())
    }

    fn save(&self, path: &Path) -> Result<()> {
        let parent = path.parent().ok_or(STORE_ERROR)?;
        let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|_| STORE_ERROR)?;
        let bytes = serde_json::to_vec(self).map_err(|_| STORE_ERROR)?;
        if bytes.len() as u64 > MAX_STORE_BYTES {
            return Err("The saved Gateway list is too large.".into());
        }
        staged.write_all(&bytes).map_err(|_| STORE_ERROR)?;
        staged.as_file().sync_all().map_err(|_| STORE_ERROR)?;
        staged.persist(path).map_err(|_| STORE_ERROR)?;
        Ok(())
    }
}

/// The form a Gateway is saved under: its origin, plus the path of a tunnel URL.
fn gateway_origin(address: &str) -> Result<(String, Target)> {
    if address.len() > MAX_ORIGIN_BYTES {
        return Err("Enter a Gateway URL of up to 2048 characters.".into());
    }
    let checked = endpoint(address)?;
    let url = tauri::Url::parse(&checked.url()).map_err(|_| "Enter a valid Gateway URL.")?;
    let mut origin = url.origin().ascii_serialization();
    if matches!(url.scheme(), "ws" | "wss") && url.path() != "/" {
        origin.push_str(url.path());
    }
    let endpoint = endpoint(&origin)?;
    Ok((origin, endpoint))
}

impl GatewayState {
    pub async fn saved_gateways(&self, path: &Path) -> Result<GatewayList> {
        let _guard = self.1.lock().await;
        Ok(self.list(Profiles::load(path)?))
    }

    pub async fn save_gateway(
        &self,
        path: &Path,
        address: String,
        name: String,
        token: String,
    ) -> Result<GatewayActivation> {
        let _guard = self.1.lock().await;
        let (origin, endpoint) = gateway_origin(&address)?;
        let _file_lock = lock_profiles(path)?;
        let name = name.trim();
        if name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err("Enter a Gateway name of up to 80 characters.".into());
        }
        // A client Auth Key joins this device once; only the enrolled credential is saved.
        let token =
            if supertag_protocol::is_secret(supertag_protocol::AUTH_KEY_SECRET_PREFIX, &token) {
                Session::connect(endpoint.clone(), &token)
                    .await?
                    .enroll(&device_name())
                    .await?
            } else {
                token
            };
        let mut profiles = Profiles::load(path)?;
        let stored = profiles
            .gateways
            .iter_mut()
            .find(|entry| entry.profile.origin == origin);
        let name = if name.is_empty() {
            origin.clone()
        } else {
            name.into()
        };
        if let Some(entry) = stored {
            entry.profile.name = name;
            if !token.is_empty() {
                bearer(&token)?;
                entry.token = token;
            }
            let authorization = entry.token.clone();
            self.activate(path, profiles, Some(origin), endpoint, &authorization)
                .await
        } else {
            bearer(&token)?;
            profiles.gateways.push(SavedGateway {
                profile: GatewayProfile {
                    name,
                    origin: origin.clone(),
                },
                token: token.clone(),
            });
            self.activate(path, profiles, Some(origin), endpoint, &token)
                .await
        }
    }

    pub async fn select_gateway(&self, path: &Path, origin: String) -> Result<GatewayActivation> {
        let _guard = self.1.lock().await;
        let _file_lock = lock_profiles(path)?;
        let profiles = Profiles::load(path)?;
        let entry = profiles
            .gateways
            .iter()
            .find(|entry| entry.profile.origin == origin)
            .ok_or("That Gateway is no longer saved.")?;
        let token = entry.token.clone();
        let (canonical, endpoint) = gateway_origin(&origin)?;
        if canonical != origin {
            return Err("The saved Gateway address is invalid.".into());
        }
        self.activate(path, profiles, Some(origin), endpoint, &token)
            .await
    }

    /// Connects to the local Gateway with the operator token its state directory holds
    /// now. Nothing about it is saved, and no saved Gateway stays active, so the next
    /// launch opens the local one again.
    pub async fn connect_local_gateway(&self, path: &Path) -> Result<GatewayActivation> {
        let _guard = self.1.lock().await;
        let local = local::discover(self.2.as_deref())?;
        let endpoint = endpoint(&local.url)?;
        let _file_lock = lock_profiles(path)?;
        let profiles = Profiles::load(path)?;
        self.activate(path, profiles, None, endpoint, &local.token)
            .await
    }

    /// Connects and makes the connection current. A saved `origin` becomes the active saved
    /// Gateway; `None` is the local Gateway, which leaves none active.
    async fn activate(
        &self,
        path: &Path,
        mut profiles: Profiles,
        origin: Option<String>,
        endpoint: Target,
        token: &str,
    ) -> Result<GatewayActivation> {
        let generation = self.0.read().await.generation;
        // Cached conversations belong to this Gateway and principal. The local Control
        // Plane is told apart by where it runs.
        let gateway = origin
            .clone()
            .unwrap_or_else(|| format!("{LOCAL} {}", endpoint.url()));
        let session = Arc::new(Session::connect(endpoint, token).await?);
        let principal = session.principal().await?;
        let tags = session.tags().await?;
        let mut state = self.0.write().await;
        if state.generation != generation {
            return Err("The connection changed. Connect again.".into());
        }
        profiles.active = origin.clone();
        profiles.save(path)?;
        let origin = origin.unwrap_or_else(|| LOCAL.to_owned());
        let connection_id = state.replace().to_string();
        state.session = Some(session);
        state.origin = Some(origin.clone());
        state.cache_scope = Some(super::cache::CacheScope {
            gateway,
            principal: principal.clone(),
        });
        Ok(GatewayActivation {
            gateways: self.list(profiles),
            origin,
            connection_id,
            tags,
            principal,
        })
    }

    pub async fn clear_gateway(&self, path: &Path, forget: Option<String>) -> Result<GatewayList> {
        let _guard = self.1.lock().await;
        let _file_lock = lock_profiles(path)?;
        let mut profiles = Profiles::load(path)?;
        let mut state = self.0.write().await;
        if let Some(origin) = &forget {
            profiles
                .gateways
                .retain(|entry| entry.profile.origin != *origin);
        }
        if forget
            .as_ref()
            .is_none_or(|origin| profiles.active.as_ref() == Some(origin))
        {
            profiles.active = None;
        }
        profiles.save(path)?;
        if forget
            .as_ref()
            .is_none_or(|origin| state.origin.as_ref() == Some(origin))
        {
            state.replace();
        }
        Ok(self.list(profiles))
    }
}
