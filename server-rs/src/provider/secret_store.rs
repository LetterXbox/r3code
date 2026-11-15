//! Process-local cache of resolved provider secrets. Values are never serialized.
use std::{collections::HashMap, sync::RwLock};

#[derive(Default)]
pub struct SecretStore {
    values: RwLock<HashMap<(String, String), String>>,
}

impl SecretStore {
    /// Apply a fresh vault read. Returns whether its value changed.
    pub fn apply(
        &self,
        provider: &str,
        reference: &str,
        value: String,
    ) -> Result<bool, &'static str> {
        if provider.is_empty() || reference.is_empty() || value.trim().is_empty() {
            return Err("Invalid secret");
        }
        let mut values = self
            .values
            .write()
            .map_err(|_| "Secret store unavailable")?;
        let key = (provider.to_owned(), reference.to_owned());
        if values.get(&key) == Some(&value) {
            return Ok(false);
        }
        values.insert(key, value);
        Ok(true)
    }

    pub fn get(&self, provider: &str, reference: &str) -> Result<Option<String>, &'static str> {
        Ok(self
            .values
            .read()
            .map_err(|_| "Secret store unavailable")?
            .get(&(provider.to_owned(), reference.to_owned()))
            .cloned())
    }

    pub fn remove_provider(&self, provider: &str) -> Result<(), &'static str> {
        self.values
            .write()
            .map_err(|_| "Secret store unavailable")?
            .retain(|(id, _), _| id != provider);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn values_are_scoped_changed_and_removable() {
        let store = SecretStore::default();
        assert!(store.apply("one", "path", "value".into()).unwrap());
        assert!(!store.apply("one", "path", "value".into()).unwrap());
        assert!(store.apply("two", "path", "other".into()).unwrap());
        assert!(store.apply("one", "path", "  ".into()).is_err());
        store.remove_provider("one").unwrap();
        assert_eq!(store.get("one", "path").unwrap(), None);
        assert_eq!(store.get("two", "path").unwrap().as_deref(), Some("other"));
    }
}
