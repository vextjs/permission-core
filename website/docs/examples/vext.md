# vext Integration

vext integrations follow the same model as other runtimes:

1. resolve the current user
2. build a stable route resource
3. call `can()` or `assert()`
4. keep data permissions in the service layer

```typescript
await pc.assert(userId, 'invoke', 'POST:/api/refunds');
```

Use `getResources(userId, 'invoke')` for menu and route visibility, but keep server-side checks as the final decision.
