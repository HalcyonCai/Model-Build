# C/C++ Model Creator (机型创建助手)

`C/C++ Model Creator` is a powerful VS Code extension designed to streamline the development process for embedded C/C++ projects that require frequent creation of new machine model configurations. It automates the tedious and error-prone task of updating multiple project files, allowing developers to create a complete and consistent new model configuration with just a few clicks.

![Extension Demo](images/demo.gif) <!-- It is recommended to create a simple GIF to demonstrate the plugin's functionality and place it here. -->

---

## Features

- **Context-Aware Command**: The "创建新机型" (Create New Model) command intelligently appears in the context menu only when you right-click a valid `Config_*.h` file.

- **Intelligent Target Selection**:
  - Automatically reads your `.vscode/c_cpp_properties.json`.
  - Filters and displays only the relevant C/C++ build targets that have not yet been defined in the current config file.
  - Ensures the target's model prefix (e.g., `PGEL_`) matches the convention of the current file.

- **Reference-Based Creation**: Select an existing model as a template, and the extension will use it as a reference to generate the new configuration.

- **Multi-File Automation**: Automatically performs updates across your entire project:
  1.  **`Config_*.h`**: Creates a new `#elif` block for the new model, copying the configuration from the reference model.
  2.  **`Custom.h`**: Finds and copies relevant `MOTOR1_TYPE` and `MOTOR2_TYPE` definitions to a new block for the new model.
  3.  **`SystemPara.c`**: Adds the corresponding `#elif` and `#include` directives for the new model's EEPROM header.
  4.  **`GenCode.bat`**: Appends the new `bin2c` command to the batch script.

- **Automated EEPROM File Generation**:
  - **Smart Rename**: If a single `.bin` file is present in the directory, it's automatically renamed to match the new model's EEPROM filename.
  - **Auto-Execution**: Runs `GenCode.bat` in the background to generate the corresponding `.h` file from the `.bin`.
  - **Auto-Cleanup**: Deletes all `.bin` files from the directory after the process is complete.
  - **Safe Mode**: If multiple `.bin` files are detected, it will safely delete them all without running the script to prevent errors.

- **Guided Input**: Provides clear input boxes for:
  - New Model Name (pre-filled with the name from the selected C/C++ target).
  - Software Version (optional).
  - EEPROM Version (optional).
  - Customer Part Number (optional).

---

## How to Use

1.  **Right-Click a `Config_*.h` File**: In the VS Code Explorer, right-click on a file like `Config_PGEL.h`.
2.  **Select "创建新机型"**: Click the "创建新机型 (Create New Model)" option from the context menu.
3.  **Choose C/C++ Target**: Select the appropriate build target for the new model from the dropdown list.
4.  **Select Reference Model**: Choose an existing model to use as a template.
5.  **Enter New Model Details**:
    - Confirm or edit the new model's name.
    - Optionally, provide the Software Version, EEPROM Version, and Customer Part Number. Press `Enter` to skip.
6.  **Done!**: The extension will automatically update all necessary files (`Config_*.h`, `Custom.h`, `SystemPara.c`, `GenCode.bat`) and handle the EEPROM `.bin` file processing.

---

## Requirements

-   [C/C++ Extension Pack](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) must be installed.
-   The project structure is expected to follow the conventions for which this plugin was designed (e.g., location of `Custom.h`, `SystemPara.c`, etc.).
-   `bin2c.exe` and `GenCode.bat` should be present in the same directory as the `Config_*.h` files.

---

**Enjoy a faster and more reliable model creation workflow!**
