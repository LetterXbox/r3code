//! Bounded ownership graph for OpenCode's native child sessions.
use std::collections::{HashMap, HashSet};
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChildLink {
    pub parent: String,
    pub child: String,
    pub call: String,
    pub background: bool,
    pub finished: bool,
}
pub(crate) struct Tree {
    root: String,
    children: HashMap<String, ChildLink>,
}
impl Tree {
    pub(crate) fn new(root: String) -> Self {
        Self {
            root,
            children: HashMap::new(),
        }
    }
    pub(crate) fn contains(&self, id: &str) -> bool {
        id == self.root || self.children.contains_key(id)
    }
    pub(crate) fn link(
        &mut self,
        parent: &str,
        child: &str,
        call: &str,
        background: bool,
    ) -> Result<bool, String> {
        if !self.contains(parent) || child.is_empty() || call.is_empty() || child == self.root {
            return Err("Invalid OpenCode child ownership".into());
        }
        if let Some(old) = self.children.get(child) {
            if old.parent == parent && old.call == call {
                return Ok(false);
            }
            return Err("OpenCode child session is already attached to another call".into());
        }
        if self.children.len() >= 1024 {
            return Err("OpenCode child session limit exceeded".into());
        }
        let mut ancestor = parent;
        let mut visited = HashSet::new();
        while ancestor != self.root {
            if ancestor == child || !visited.insert(ancestor.to_owned()) {
                return Err("OpenCode child ownership cycle".into());
            }
            ancestor = &self
                .children
                .get(ancestor)
                .ok_or("OpenCode child owner unavailable")?
                .parent;
        }
        self.children.insert(
            child.to_owned(),
            ChildLink {
                parent: parent.into(),
                child: child.into(),
                call: call.into(),
                background,
                finished: false,
            },
        );
        Ok(true)
    }
    pub(crate) fn finish(&mut self, child: &str) -> Option<&ChildLink> {
        let entry = self.children.get_mut(child)?;
        entry.finished = true;
        Some(entry)
    }
    pub(crate) fn has_live_foreground_child(&self, parent: &str) -> bool {
        self.children
            .values()
            .any(|child| child.parent == parent && !child.background && !child.finished)
    }
    #[cfg(test)]
    pub(crate) fn live_descendants(&self, parent: &str) -> Vec<&ChildLink> {
        self.children
            .values()
            .filter(|entry| {
                if entry.finished {
                    return false;
                }
                let mut current = entry.parent.as_str();
                let mut depth = 0;
                loop {
                    if current == parent {
                        return true;
                    }
                    if current == self.root || depth > 1024 {
                        return false;
                    }
                    let Some(next) = self.children.get(current) else {
                        return false;
                    };
                    current = &next.parent;
                    depth += 1;
                }
            })
            .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_children_are_scoped_and_rebinding_is_rejected() {
        let mut tree = Tree::new("root".into());
        assert!(tree.link("root", "child", "call1", false).unwrap());
        assert!(!tree.link("root", "child", "call1", false).unwrap());
        assert!(tree.link("child", "grandchild", "call2", true).unwrap());
        assert_eq!(tree.live_descendants("root").len(), 2);
        assert_eq!(tree.live_descendants("child").len(), 1);
        assert!(tree.link("root", "grandchild", "different", false).is_err());
        assert!(tree.link("unknown", "x", "call3", false).is_err());
        assert!(tree.link("grandchild", "root", "call4", false).is_err());
        tree.finish("grandchild");
        assert!(tree.live_descendants("child").is_empty());
    }
}
