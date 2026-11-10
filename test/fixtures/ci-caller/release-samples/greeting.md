# Greeting

The fixture's one export, read from the installed tarball by the package's published name. The
release samples gate runs this page in `self-check.yml`.

```js
import { greeting } from "ci-caller-fixture";

greeting; // => "hello from the CI caller fixture"
```
