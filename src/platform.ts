import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { join } from 'path';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { SharkIQAccessory } from './platformAccessory';

import { Login } from './login';

import { get_ayla_api } from './sharkiq-js/ayla_api';
import { SharkIqVacuum } from './sharkiq-js/sharkiq';
import { global_vars } from './sharkiq-js/const';

export class SharkIQPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = []; // Cached accessories
  public vacuumDevices: SharkIqVacuum[] = []; // Discovered vacuums

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Initializing SharkIQ platform:', this.config.name);

    this.api.on('didFinishLaunching', async () => {
      try {
        await this.initializePlatform();
      } catch (error) {
        this.log.error('Failed to initialize SharkIQ platform:', error);
      }
    });
  }

  /**
   * Main initialization logic for the platform.
   */
  private async initializePlatform(): Promise<void> {
    const serialNumbers = this.config.vacuums;
    if (!Array.isArray(serialNumbers) || serialNumbers.length === 0) {
      this.log.error('No vacuum DSNs provided in the configuration.');
      return;
    }

    try {
      this.log.info('Logging into SharkIQ platform...');
      const devices = await this.login();
      this.vacuumDevices = devices.filter((device) => serialNumbers.includes(device._dsn));

      if (this.vacuumDevices.length === 0) {
        this.log.warn('No matching vacuum DSNs found in your account.');
      } else {
        this.log.info(`Discovered ${this.vacuumDevices.length} matching vacuum(s).`);
        this.discoverDevices();
      }
    } catch (error) {
      this.log.error('Error during login or device discovery:', error);
    }
  }

  /**
   * Logs into the SharkIQ API and retrieves devices.
   */
  private async login(): Promise<SharkIqVacuum[]> {
    const europe = this.config.europe || false;
    const storagePath = this.api.user.storagePath();
    const authFile = join(storagePath, global_vars.FILE);
    const oauthFile = join(storagePath, global_vars.OAUTH.FILE);
    const oAuthCode = this.config.oAuthCode || '';
    const email = this.config.email || '';
    const password = this.config.password || '';

    if (!email && !oAuthCode) {
      throw new Error('Either email/password or OAuth code must be provided in the configuration.');
    }

    const login = new Login(this.log, authFile, oauthFile, email, password, oAuthCode);

    try {
      await login.checkLogin();
      const aylaApi = get_ayla_api(authFile, this.log, europe);
      await aylaApi.sign_in();
      const devices = await aylaApi.get_devices();
      this.log.info('Successfully logged into SharkIQ API.');
      return devices;
    } catch (error) {
      this.log.error('Login failed:', error);
      throw error;
    }
  }

  /**
   * Restores cached accessories during Homebridge initialization.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  /**
   * Discovers SharkIQ vacuum devices and registers them with Homebridge.
   */
  private discoverDevices(): void {
    const devicesToRegister: PlatformAccessory[] = [];
    const unusedAccessories = [...this.accessories]; // Clone cached accessories

    const invertDockedStatus = this.config.invertDockedStatus || false;
    const dockedUpdateInterval = this.config.dockedUpdateInterval || 5000;

    for (const vacuumDevice of this.vacuumDevices) {
      const uuid = this.api.hap.uuid.generate(vacuumDevice._dsn.toString());
      let accessory = unusedAccessories.find((acc) => acc.UUID === uuid);

      if (accessory) {
        unusedAccessories.splice(unusedAccessories.indexOf(accessory), 1);
        this.log.info(`Updating existing accessory: ${accessory.displayName}`);
      } else {
        accessory = new this.api.platformAccessory(vacuumDevice._name.toString(), uuid);
        devicesToRegister.push(accessory);
        this.log.info(`Adding new accessory: ${accessory.displayName}`);
      }

      // Set accessory information
      this.setupAccessoryInformation(accessory, vacuumDevice);

      // Create SharkIQAccessory
      new SharkIQAccessory(
        this,
        accessory,
        vacuumDevice,
        this.api.hap.uuid,
        this.log,
        invertDockedStatus,
        dockedUpdateInterval,
      );
    }

    // Register new devices
    if (devicesToRegister.length > 0) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, devicesToRegister);
      this.accessories.push(...devicesToRegister);
      this.log.info(`Registered ${devicesToRegister.length} new accessory(ies).`);
    }

    // Unregister unused accessories
    if (unusedAccessories.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, unusedAccessories);
      this.log.info(`Removed ${unusedAccessories.length} unused accessory(ies).`);
    }
  }

  /**
   * Sets up accessory information (e.g., manufacturer, model, serial number).
   */
  private setupAccessoryInformation(accessory: PlatformAccessory, vacuumDevice: SharkIqVacuum): void {
    let accessoryInfo = accessory.getService(this.Service.AccessoryInformation);
    if (!accessoryInfo) {
      accessoryInfo = accessory.addService(this.Service.AccessoryInformation);
    }

    accessoryInfo
      .setCharacteristic(this.Characteristic.Manufacturer, 'Shark')
      .setCharacteristic(this.Characteristic.Model, vacuumDevice._vac_model_number || 'Unknown')
      .setCharacteristic(this.Characteristic.SerialNumber, vacuumDevice._dsn);
  }
}
